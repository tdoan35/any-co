#!/usr/bin/env python3
"""Convert the Steam catalog CSV into a typed SQLite database, once.

    python3 tools/catalog/prep.py [--csv PATH] [--out PATH]

Fixes the broken header (`DiscountDLC count` is two columns), parses dates, owner
ranges, and list fields, and flags rows that aren't real released games (playtests,
demos, soundtracks, empty entries) so queries can filter them out.

Tables:
  games(appid PK, name, release_date ISO, release_year, owners_low, owners_high,
        peak_ccu, required_age, price, discount, dlc_count, windows, mac, linux,
        metacritic, user_score, positive, negative, reviews_total, positive_ratio,
        recommendations, achievements, avg_playtime, median_playtime,
        developers, publishers, languages, about, header_image, is_real)
  game_tags(appid, tag)  game_genres(appid, genre)  game_categories(appid, category)
  meta(key, value)       -- snapshot_date, tag_coverage_end, row counts, source
Stdlib only, so it runs anywhere Python 3.9+ does.
"""
import argparse
import ast
import csv
import os
import re
import sqlite3
import sys
from datetime import date, datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_CSV = os.path.join(ROOT, "data", "steam-games-dataset", "games.csv")
DEFAULT_OUT = os.path.join(ROOT, "data", "catalog.sqlite")

EXPECTED_COLUMNS = 40
JUNK_NAME = re.compile(r"\b(playtest|demo|soundtrack|ost|test server|dedicated server|sdk|level editor)\b", re.I)

SCHEMA = """
CREATE TABLE games (
  appid INTEGER PRIMARY KEY, name TEXT, release_date TEXT, release_year INTEGER,
  owners_low INTEGER, owners_high INTEGER, peak_ccu INTEGER, required_age INTEGER,
  price REAL, discount INTEGER, dlc_count INTEGER,
  windows INTEGER, mac INTEGER, linux INTEGER,
  metacritic INTEGER, user_score INTEGER, positive INTEGER, negative INTEGER,
  reviews_total INTEGER, positive_ratio REAL, recommendations INTEGER, achievements INTEGER,
  avg_playtime INTEGER, median_playtime INTEGER,
  developers TEXT, publishers TEXT, languages TEXT, about TEXT, header_image TEXT,
  is_real INTEGER
);
CREATE TABLE game_tags (appid INTEGER, tag TEXT);
CREATE TABLE game_genres (appid INTEGER, genre TEXT);
CREATE TABLE game_categories (appid INTEGER, category TEXT);
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
"""
INDEXES = """
CREATE INDEX ix_tags_tag ON game_tags(tag, appid);
CREATE INDEX ix_tags_app ON game_tags(appid);
CREATE INDEX ix_genres_genre ON game_genres(genre, appid);
CREATE INDEX ix_cats_cat ON game_categories(category, appid);
CREATE INDEX ix_games_real_date ON games(is_real, release_date);
"""


def fixed_header(header):
    out = []
    for h in header:
        if h == "DiscountDLC count":
            out += ["Discount", "DLC count"]
        else:
            out.append(h)
    if len(out) != EXPECTED_COLUMNS:
        raise SystemExit(f"header has {len(out)} columns after fix, expected {EXPECTED_COLUMNS}")
    return out


def to_int(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def to_bool(v):
    return 1 if str(v).strip().lower() == "true" else 0


def parse_date(v):
    v = (v or "").strip()
    for fmt in ("%b %d, %Y", "%b %Y", "%d %b, %Y", "%B %d, %Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(v, fmt).date()
        except ValueError:
            pass
    return None


def parse_owners(v):
    m = re.match(r"\s*(\d+)\s*-\s*(\d+)\s*$", v or "")
    return (int(m.group(1)), int(m.group(2))) if m else (0, 0)


def split_list(v):
    return [x.strip() for x in (v or "").split(",") if x.strip()]


def parse_pylist(v):
    try:
        val = ast.literal_eval(v) if v else []
        return [str(x) for x in val] if isinstance(val, list) else []
    except (ValueError, SyntaxError):
        return []


def is_real(name, tags, genres, reviews_total, release):
    if not name or release is None:
        return 0
    if JUNK_NAME.search(name):
        return 0
    # Rows from ~2025 on mostly have genres but no tags or reviews (missing upstream, in the
    # JSON too), so genres alone are enough to count as a real release.
    if not tags and not genres:
        return 0
    return 1


def build(csv_path, out_path):
    if not os.path.exists(csv_path):
        raise SystemExit(f"missing {csv_path}; see data/README.md")
    csv.field_size_limit(sys.maxsize)
    tmp = out_path + ".tmp"
    if os.path.exists(tmp):
        os.remove(tmp)
    db = sqlite3.connect(tmp)
    db.executescript("PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;" + SCHEMA)

    rows = skipped = real = 0
    per_day = {}
    per_month = {}  # month -> [real releases, real releases with tags]
    seen = set()
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        cols = fixed_header(next(reader))
        idx = {c: i for i, c in enumerate(cols)}
        g = lambda row, c: row[idx[c]]
        batch, tag_b, gen_b, cat_b = [], [], [], []
        for row in reader:
            if len(row) != EXPECTED_COLUMNS:
                skipped += 1
                continue
            appid = to_int(g(row, "AppID"))
            if not appid or appid in seen:
                skipped += 1
                continue
            seen.add(appid)
            rows += 1
            name = g(row, "Name").strip()
            release = parse_date(g(row, "Release date"))
            lo, hi = parse_owners(g(row, "Estimated owners"))
            pos, neg = to_int(g(row, "Positive")), to_int(g(row, "Negative"))
            total = pos + neg
            tags = list(dict.fromkeys(split_list(g(row, "Tags"))))
            genres = list(dict.fromkeys(split_list(g(row, "Genres"))))
            cats = list(dict.fromkeys(split_list(g(row, "Categories"))))
            real_flag = is_real(name, tags, genres, total, release)
            real += real_flag
            if real_flag:
                per_day[release] = per_day.get(release, 0) + 1
                m = per_month.setdefault(release.strftime("%Y-%m"), [0, 0])
                m[0] += 1
                m[1] += 1 if tags else 0
            batch.append((
                appid, name, release.isoformat() if release else None,
                release.year if release else None, lo, hi,
                to_int(g(row, "Peak CCU")), to_int(g(row, "Required age")),
                to_float(g(row, "Price")), to_int(g(row, "Discount")), to_int(g(row, "DLC count")),
                to_bool(g(row, "Windows")), to_bool(g(row, "Mac")), to_bool(g(row, "Linux")),
                to_int(g(row, "Metacritic score")), to_int(g(row, "User score")),
                pos, neg, total, round(pos / total, 4) if total else None,
                to_int(g(row, "Recommendations")), to_int(g(row, "Achievements")),
                to_int(g(row, "Average playtime forever")), to_int(g(row, "Median playtime forever")),
                g(row, "Developers"), g(row, "Publishers"),
                ",".join(parse_pylist(g(row, "Supported languages"))),
                g(row, "About the game"), g(row, "Header image"), real_flag,
            ))
            tag_b += [(appid, t) for t in tags]
            gen_b += [(appid, x) for x in genres]
            cat_b += [(appid, x) for x in cats]
            if len(batch) >= 5000:
                flush(db, batch, tag_b, gen_b, cat_b)
                batch, tag_b, gen_b, cat_b = [], [], [], []
        flush(db, batch, tag_b, gen_b, cat_b)

    # Snapshot = latest day with 3+ releases (a few rows carry future "coming soon" dates).
    busy = [d for d, n in per_day.items() if n >= 3 and d <= date.today()]
    snapshot = max(busy) if busy else None
    # Tag coverage end = last month (with 100+ releases) where most releases have tags.
    covered = [m for m, (n, t) in per_month.items() if n >= 100 and t / n >= 0.5]
    tag_coverage_end = max(covered) if covered else ""
    meta = {
        "source": os.path.relpath(csv_path, ROOT),
        "rows": rows, "real_games": real, "skipped_rows": skipped,
        "snapshot_date": snapshot.isoformat() if snapshot else "",
        "tag_coverage_end": tag_coverage_end,
        "built_at": datetime.now().isoformat(timespec="seconds"),
    }
    db.executemany("INSERT INTO meta VALUES (?, ?)", [(k, str(v)) for k, v in meta.items()])
    db.executescript(INDEXES)
    db.commit()
    db.execute("ANALYZE")
    db.close()
    os.replace(tmp, out_path)
    return meta


def flush(db, batch, tag_b, gen_b, cat_b):
    db.executemany(f"INSERT INTO games VALUES ({','.join('?' * 30)})", batch)
    db.executemany("INSERT INTO game_tags VALUES (?, ?)", tag_b)
    db.executemany("INSERT INTO game_genres VALUES (?, ?)", gen_b)
    db.executemany("INSERT INTO game_categories VALUES (?, ?)", cat_b)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--csv", default=DEFAULT_CSV)
    ap.add_argument("--out", default=DEFAULT_OUT)
    a = ap.parse_args()
    meta = build(a.csv, a.out)
    for k, v in meta.items():
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()
