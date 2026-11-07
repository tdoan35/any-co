#!/usr/bin/env python3
"""Fixed, deterministic queries over data/catalog.sqlite. Prints JSON.

    python3 tools/catalog/query.py <command> [options]

Commands:
  meta                         snapshot date, tag coverage, analysis window, baseline
  find-tags  --q TEXT          exact tag names matching TEXT (tags are case-sensitive)
  tags       [--min N]         one row per tag: supply, demand, opportunity (ranked)
  pairs      [--base TAG]      tag pairs (optionally all containing TAG), ranked by opportunity
  niche      --tags A,B        full profile of games having ALL tags: stats, yearly trend, top games
  games      --tags A,B        comparable games (sorted by reviews), with a short description
  game       --appid N | --name TEXT   one game's record

Definitions (all computed here, never by an LLM):
  window        24 months of releases ending at meta.tag_coverage_end. Tags and reviews are
                missing for most releases after that (an upstream data gap), so tag metrics
                only use this window. Trend checks after it need live Steam data.
  supply        releases in the window with these tags.
  traction      share of window releases with >= 50 reviews (roughly 1.5k+ sales).
  hit_rate      share of window releases with >= 500 reviews.
  demand        traction, shrunk toward the baseline for small samples:
                (hits50 + K*baseline) / (supply + K), K = 20.
  opportunity   demand_pct * (1 - supply_pct), percentile ranks within the returned set.
                `niche` ranks against the default `pairs` set, so any tag set can be scored.
                Feasibility and marketability are NOT in this score; agents judge those.
"""
import argparse
import itertools
import json
import os
import sqlite3
import sys
from statistics import median

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEFAULT_DB = os.environ.get("CATALOG_DB", os.path.join(ROOT, "data", "catalog.sqlite"))
TRACTION = 50
HIT = 500
SHRINK_K = 20
WINDOW_MONTHS = 24


def connect(path):
    if not os.path.exists(path):
        raise SystemExit(f"missing {path}; run: python3 tools/catalog/prep.py")
    db = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    db.row_factory = sqlite3.Row
    return db


def meta(db):
    m = {r["key"]: r["value"] for r in db.execute("SELECT key, value FROM meta")}
    end = m["tag_coverage_end"]  # YYYY-MM
    y, mo = int(end[:4]), int(end[5:7])
    total = y * 12 + (mo - 1) - (WINDOW_MONTHS - 1)
    start = f"{total // 12:04d}-{total % 12 + 1:02d}"
    m["window_start"] = f"{start}-01"
    m["window_end"] = f"{end}-31"
    return m


def window_games(db, m):
    """appid -> (reviews_total, price, positive_ratio) for real, tagged releases in the window."""
    rows = db.execute(
        """SELECT appid, reviews_total, price, positive_ratio FROM games
           WHERE is_real = 1 AND release_date BETWEEN ? AND ?
             AND appid IN (SELECT appid FROM game_tags)""",
        (m["window_start"], m["window_end"]),
    )
    return {r[0]: (r[1], r[2], r[3]) for r in rows}


def tags_by_game(db, appids):
    out = {}
    for appid, tag in db.execute("SELECT appid, tag FROM game_tags"):
        if appid in appids:
            out.setdefault(appid, []).append(tag)
    return out


def pct(sorted_vals, v):
    if not sorted_vals:
        return 0.0
    lo, hi = 0, len(sorted_vals)
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_vals[mid] < v:
            lo = mid + 1
        else:
            hi = mid
    return round(lo / len(sorted_vals), 3)


def summarize(games, baseline):
    """games: list of (reviews_total, price, positive_ratio)."""
    n = len(games)
    if not n:
        return {"supply": 0}
    reviews = sorted(g[0] for g in games)
    hits50 = sum(1 for r in reviews if r >= TRACTION)
    hits500 = sum(1 for r in reviews if r >= HIT)
    paid = [g[1] for g in games if g[1] > 0]
    rated = [g[2] for g in games if g[2] is not None and g[0] >= 10]
    return {
        "supply": n,
        "traction": round(hits50 / n, 4),
        "hit_rate": round(hits500 / n, 4),
        "demand": round((hits50 + SHRINK_K * baseline) / (n + SHRINK_K), 4),
        "median_reviews": float(median(reviews)),
        "p90_reviews": reviews[min(n - 1, int(n * 0.9))],
        "median_price_paid": round(median(paid), 2) if paid else None,
        "free_share": round(1 - len(paid) / n, 3),
        "median_positive_ratio": round(median(rated), 3) if rated else None,
    }


def rank(rows):
    demands = sorted(r["demand"] for r in rows)
    supplies = sorted(r["supply"] for r in rows)
    for r in rows:
        r["demand_pct"] = pct(demands, r["demand"])
        r["supply_pct"] = pct(supplies, r["supply"])
        r["opportunity"] = round(r["demand_pct"] * (1 - r["supply_pct"]), 4)
    rows.sort(key=lambda r: (-r["opportunity"], -r["demand"]))
    return rows


def baseline_of(wg):
    n = len(wg)
    return sum(1 for g in wg.values() if g[0] >= TRACTION) / n if n else 0.0


def cmd_meta(db, a):
    m = meta(db)
    wg = window_games(db, m)
    m["window_releases_tagged"] = len(wg)
    m["baseline"] = summarize(list(wg.values()), baseline_of(wg))
    m["tag_count"] = db.execute("SELECT COUNT(DISTINCT tag) FROM game_tags").fetchone()[0]
    return m


def cmd_find_tags(db, a):
    rows = db.execute(
        """SELECT tag, COUNT(*) n FROM game_tags WHERE tag LIKE ? GROUP BY tag ORDER BY n DESC LIMIT 50""",
        (f"%{a.q}%",),
    )
    return [{"tag": r[0], "games_all_time": r[1]} for r in rows]


def broad_tags(tg, share):
    counts = {}
    for tags in tg.values():
        for t in tags:
            counts[t] = counts.get(t, 0) + 1
    n = len(tg) or 1
    return {t for t, c in counts.items() if c / n > share}


def cmd_tags(db, a):
    m = meta(db)
    wg = window_games(db, m)
    base = baseline_of(wg)
    tg = tags_by_game(db, wg)
    groups = {}
    for appid, tags in tg.items():
        for t in tags:
            groups.setdefault(t, []).append(wg[appid])
    rows = [dict(tag=t, **summarize(g, base)) for t, g in groups.items() if len(g) >= a.min]
    return {"window": [m["window_start"], m["window_end"]], "baseline_traction": round(base, 4),
            "rows": rank(rows)[: a.limit]}


def cmd_pairs(db, a):
    m = meta(db)
    wg = window_games(db, m)
    base = baseline_of(wg)
    tg = tags_by_game(db, wg)
    skip = set() if a.keep_broad else broad_tags(tg, a.broad_share)
    if a.base:
        skip.discard(a.base)
    groups = {}
    for appid, tags in tg.items():
        tags = sorted(t for t in set(tags) if t not in skip)
        if a.base and a.base not in tags:
            continue
        for p in itertools.combinations(tags, 2):
            if a.base and a.base not in p:
                continue
            groups.setdefault(p, []).append(wg[appid])
    rows = [dict(tags=list(p), **summarize(g, base)) for p, g in groups.items() if len(g) >= a.min]
    return {"window": [m["window_start"], m["window_end"]], "baseline_traction": round(base, 4),
            "excluded_broad_tags": sorted(skip), "rows": rank(rows)[: a.limit]}


REF_MIN_SUPPLY = 30


def reference_rows(db, m, wg, base):
    """The default `pairs` result set (supply >= 30, broad tags skipped): the reference
    distribution that niche percentiles are ranked against."""
    tg = tags_by_game(db, wg)
    skip = broad_tags(tg, 0.25)
    groups = {}
    for appid, tags in tg.items():
        tags = sorted(t for t in set(tags) if t not in skip)
        for p in itertools.combinations(tags, 2):
            groups.setdefault(p, []).append(wg[appid])
    return [summarize(g, base) for g in groups.values() if len(g) >= REF_MIN_SUPPLY]


def appids_with_all(db, tags):
    q = " INTERSECT ".join(["SELECT appid FROM game_tags WHERE tag = ?"] * len(tags))
    return [r[0] for r in db.execute(q, tags)]


def parse_tags(s):
    tags = [t.strip() for t in (s or "").split(",") if t.strip()]
    if not tags:
        raise SystemExit("--tags is required, e.g. --tags 'Roguelite,Deckbuilding'")
    return tags


def unknown_tags(db, tags):
    return [t for t in tags if not db.execute("SELECT 1 FROM game_tags WHERE tag = ? LIMIT 1", (t,)).fetchone()]


def cmd_niche(db, a):
    tags = parse_tags(a.tags)
    bad = unknown_tags(db, tags)
    if bad:
        return {"error": f"unknown tags {bad}; use find-tags"}
    m = meta(db)
    ids = appids_with_all(db, tags)
    wg = window_games(db, m)
    base = baseline_of(wg)
    in_window = [wg[i] for i in ids if i in wg]
    marks = ",".join("?" * len(ids)) or "NULL"
    yearly = []
    for r in db.execute(
        f"""SELECT release_year y, COUNT(*) n, SUM(reviews_total >= {TRACTION}) t
            FROM games WHERE is_real = 1 AND appid IN ({marks}) AND release_year >= 2016
            GROUP BY y ORDER BY y""", ids):
        yearly.append({"year": r["y"], "releases_tagged": r["n"], "traction": round((r["t"] or 0) / r["n"], 3)})
    stats = summarize(in_window, base)
    ref = reference_rows(db, m, wg, base)
    if ref and stats["supply"]:
        stats["demand_pct"] = pct(sorted(r["demand"] for r in ref), stats["demand"])
        stats["supply_pct"] = pct(sorted(r["supply"] for r in ref), stats["supply"])
        stats["opportunity"] = round(stats["demand_pct"] * (1 - stats["supply_pct"]), 4)
    top = top_games(db, ids, a.limit, None)
    top_recent = top_games(db, ids, a.limit, m["window_start"])
    return {
        "tags": tags, "games_all_time": len(ids),
        "window": [m["window_start"], m["window_end"]],
        "window_stats": stats, "baseline_traction": round(base, 4),
        "percentile_reference": f"tag pairs with supply >= {REF_MIN_SUPPLY} (the default `pairs` set)",
        "yearly": yearly,
        "yearly_note": f"releases after {m['tag_coverage_end']} are mostly untagged; recent years undercount",
        "top_all_time": top, "top_in_or_after_window": top_recent,
    }


def top_games(db, ids, limit, since, about_chars=0):
    marks = ",".join("?" * len(ids)) or "NULL"
    params = list(ids)
    where = f"is_real = 1 AND appid IN ({marks})"
    if since:
        where += " AND release_date >= ?"
        params.append(since)
    rows = db.execute(
        f"""SELECT appid, name, release_date, price, reviews_total, positive_ratio,
                   owners_low, owners_high, median_playtime, developers, about
            FROM games WHERE {where} ORDER BY reviews_total DESC LIMIT ?""", params + [limit])
    out = []
    for r in rows:
        d = {k: r[k] for k in ("appid", "name", "release_date", "price", "reviews_total",
                               "positive_ratio", "owners_low", "owners_high", "median_playtime", "developers")}
        if about_chars:
            d["about"] = (r["about"] or "")[:about_chars]
        out.append(d)
    return out


def cmd_games(db, a):
    tags = parse_tags(a.tags)
    bad = unknown_tags(db, tags)
    if bad:
        return {"error": f"unknown tags {bad}; use find-tags"}
    ids = appids_with_all(db, tags)
    games = top_games(db, ids, a.limit, a.since, about_chars=a.about_chars)
    for g in games:
        g["tags"] = [r[0] for r in db.execute("SELECT tag FROM game_tags WHERE appid = ?", (g["appid"],))][:15]
    return {"tags": tags, "matches": len(ids), "games": games}


def cmd_game(db, a):
    if a.appid:
        r = db.execute("SELECT * FROM games WHERE appid = ?", (a.appid,)).fetchone()
    elif a.name:
        # Exact (case-insensitive) name first, then the most-reviewed substring match.
        r = db.execute(
            """SELECT * FROM games WHERE name LIKE ?
               ORDER BY lower(name) = lower(?) DESC, reviews_total DESC LIMIT 1""",
            (f"%{a.name}%", a.name)).fetchone()
    else:
        raise SystemExit("game needs --appid or --name")
    if not r:
        return {"error": "not found"}
    d = dict(r)
    d["about"] = (d["about"] or "")[: a.about_chars]
    for tbl, col in (("game_tags", "tag"), ("game_genres", "genre"), ("game_categories", "category")):
        d[tbl.split("_")[1]] = [x[0] for x in db.execute(f"SELECT {col} FROM {tbl} WHERE appid = ?", (d["appid"],))]
    return d


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=DEFAULT_DB)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("meta")
    p = sub.add_parser("find-tags"); p.add_argument("--q", required=True)
    p = sub.add_parser("tags"); p.add_argument("--min", type=int, default=50); p.add_argument("--limit", type=int, default=60)
    p = sub.add_parser("pairs")
    p.add_argument("--base"); p.add_argument("--min", type=int, default=30); p.add_argument("--limit", type=int, default=60)
    p.add_argument("--broad-share", type=float, default=0.25, help="skip tags on more than this share of window games")
    p.add_argument("--keep-broad", action="store_true")
    p = sub.add_parser("niche"); p.add_argument("--tags", required=True); p.add_argument("--limit", type=int, default=10)
    p = sub.add_parser("games"); p.add_argument("--tags", required=True); p.add_argument("--limit", type=int, default=20)
    p.add_argument("--since", help="YYYY-MM-DD"); p.add_argument("--about-chars", type=int, default=300)
    p = sub.add_parser("game"); p.add_argument("--appid", type=int); p.add_argument("--name")
    p.add_argument("--about-chars", type=int, default=1200)
    a = ap.parse_args(argv)
    db = connect(a.db)
    fn = globals()["cmd_" + a.cmd.replace("-", "_")]
    json.dump(fn(db, a), sys.stdout, indent=1, default=str)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
