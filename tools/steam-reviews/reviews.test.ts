import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanReviewHtml, mentions, parseCards, summarize, type Review } from "./reviews.ts";

const card = (author: string, verdict: string, hours: string, body: string, helpful = 3) => `
<div data-panel="{}" role="button" class="apphub_Card modalContentLink interactable" data-modal-content-url="https://steamcommunity.com/${author}/recommended/123/">
  <div class="found_helpful">${helpful} people found this review helpful</div>
  <div class="vote_header"><div class="reviewInfo"><div class="title">${verdict}</div><div class="hours">${hours} hrs on record</div></div></div>
  <div class="apphub_CardTextContent">
    <div class="date_posted">Posted: March 10, 2024</div>
    ${body}
  </div>
</div>`;

test("parses review cards from Community HTML", () => {
  const html = card("id/alice", "Recommended", "1,234.5", "Great &quot;deck&quot; game<br><br>Love it") + card("profiles/765", "Not Recommended", "0.8", "Too <b>short</b>.", 0);
  const r = parseCards(html);
  assert.equal(r.length, 2);
  assert.deepEqual(
    { id: r[0].id, up: r[0].voted_up, h: r[0].hours, p: r[0].posted, help: r[0].helpful, t: r[0].text },
    { id: "id/alice", up: true, h: 1234.5, p: "March 10, 2024", help: 3, t: 'Great "deck" game\nLove it' },
  );
  assert.equal(r[1].voted_up, false);
  assert.equal(r[1].text, "Too short.");
  assert.equal(cleanReviewHtml("a<br/>b &amp; c"), "a\nb & c");
});

const rv = (id: string, text: string, hours = 10): Review => ({ id, voted_up: false, hours, posted: null, helpful: 0, early_access: false, free_copy: false, text });

test("mentions: word-start matching, alternatives, shares, examples", () => {
  const set = [rv("a", "Way too short and buggy"), rv("b", "Bugs everywhere"), rv("c", "I want a debug mode"), rv("d", "Fine but pricey", 1)];
  const [bug, short, price] = mentions(set, ["bug", "short|brief", "price"]);
  assert.equal(bug.count, 2); // "buggy", "Bugs" yes; "debug" no
  assert.equal(bug.share, 0.5);
  assert.deepEqual(bug.examples.map((e) => e.review_id), ["a", "b"]);
  assert.equal(short.count, 1);
  assert.equal(price.count, 1);
  assert.deepEqual(summarize(set), { count: 4, median_hours: 10, under_2h_share: 0.25, early_access_share: 0 });
});
