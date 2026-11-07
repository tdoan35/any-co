#!/usr/bin/env python3
"""Smoke test for tools/catalog: builds a tiny fixture CSV (with the real broken header),
runs prep.py on it, and checks every query command. Doesn't need the real dataset.

    python3 tools/catalog/smoke_test.py
"""
import contextlib
import csv
import io
import json
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prep  # noqa: E402
import query  # noqa: E402

HEADER = ("AppID,Name,Release date,Estimated owners,Peak CCU,Required age,Price,DiscountDLC count,"
          "About the game,Supported languages,Full audio languages,Reviews,Header image,Website,"
          "Support url,Support email,Windows,Mac,Linux,Metacritic score,Metacritic url,User score,"
          "Positive,Negative,Score rank,Achievements,Recommendations,Notes,Average playtime forever,"
          "Average playtime two weeks,Median playtime forever,Median playtime two weeks,Developers,"
          "Publishers,Categories,Genres,Tags,Screenshots,Movies").split(",")


def row(appid, name, date, pos, tags, genres="Indie", price="4.99"):
    return [str(appid), name, date, "0 - 20000", "0", "0", price, "0", "0", "About " + name,
            "['English']", "[]", "", "", "", "", "", "True", "False", "False", "0", "", "0",
            str(pos), "1", "", "0", "0", "", "0", "0", "0", "0", "Dev", "Pub",
            "Single-player", genres, tags, "", ""]


def fixture(path):
    rows = []
    # 150 tagged releases in one month inside the window, so tag coverage is detected.
    for i in range(150):
        tags = "Roguelike,Pixel Graphics" if i % 3 == 0 else "Puzzle,Cozy"
        rows.append(row(1000 + i, f"Game {i}", "Mar 3, 2025", 600 if i % 5 == 0 else 3, tags))
    rows.append(row(2000, "Junk Playtest", "Mar 3, 2025", 0, "Roguelike"))
    rows.append(row(2001, "Untagged New", "Jan 9, 2026", 0, "", genres="Action"))
    rows.append(row(2002, "Future Thing", "Dec 1, 2030", 0, "Puzzle"))
    rows.append(row(1000, "Duplicate", "Mar 3, 2025", 0, "Puzzle"))
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(HEADER)
        w.writerows(rows)


def q(db, *args):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        query.main(["--db", db, *args])
    return json.loads(buf.getvalue())


def main():
    with tempfile.TemporaryDirectory() as d:
        src, db = os.path.join(d, "games.csv"), os.path.join(d, "catalog.sqlite")
        fixture(src)
        m = prep.build(src, db)
        assert m["rows"] == 153, m                     # duplicate appid dropped
        assert m["skipped_rows"] == 1, m
        assert m["real_games"] == 152, m               # playtest excluded; genre-only kept
        assert m["tag_coverage_end"] == "2025-03", m
        assert m["snapshot_date"] == "2025-03-03", m   # future-dated row ignored

        meta = q(db, "meta")
        assert meta["window_start"] == "2023-04-01" and meta["window_end"] == "2025-03-31", meta
        assert meta["window_releases_tagged"] == 150, meta  # future-dated row is outside the window
        assert abs(meta["baseline"]["hit_rate"] - 30 / 150) < 1e-3, meta

        assert q(db, "find-tags", "--q", "rogue")[0]["tag"] == "Roguelike"

        tags = q(db, "tags", "--min", "1")
        assert {r["tag"] for r in tags["rows"]} >= {"Roguelike", "Puzzle"}, tags
        assert all(0 <= r["opportunity"] <= 1 for r in tags["rows"])

        pairs = q(db, "pairs", "--min", "1", "--keep-broad")
        assert any(r["tags"] == ["Pixel Graphics", "Roguelike"] for r in pairs["rows"]), pairs

        niche = q(db, "niche", "--tags", "Roguelike,Pixel Graphics")
        assert niche["games_all_time"] == 50 and niche["window_stats"]["supply"] == 50, niche
        assert "percentile_reference" in niche, niche  # fixture tags are all "broad", so no percentiles
        assert "error" in q(db, "niche", "--tags", "Nope")

        games = q(db, "games", "--tags", "Roguelike", "--limit", "3")
        assert len(games["games"]) == 3 and games["games"][0]["reviews_total"] == 601, games

        g = q(db, "game", "--name", "Game 7")
        assert g["appid"] == 1007 and "Puzzle" in g["tags"], g
    print("catalog smoke test: ok")


if __name__ == "__main__":
    main()
