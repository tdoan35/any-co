# Social campaign

The Social Media Manager runs at release, after the Marketing Lead. The Marketing Lead owns the hook, the store page, and the trailer plan. This agent packages that into a campaign of **video, photo, and text**, and publishes it through **Naïve Social**.

Community & Outreach still owns venue drafts and press email. It does not post this campaign.

## Publish path

Posts go out through the studio identity's Naïve Social workspace (`POST /v1/identities/{identity}/social/posts`, tool `social.post`).

- The operator connects the accounts once, in the hosted portal. The agent never sees the OAuth token.
- `social.post` defaults to **ask**. A post waits for a person even when the agent's other tools are allowed.
- Set `ai_generated: true` on every post. Naïve then applies the network's own AI label where it has one (TikTok, YouTube, Instagram, X) and appends `#AIgenerated` to the caption.
- One non-X post costs $0.013. A post that also includes X costs more, and an X post that contains a link costs more again. One multi-network post pays the base once.
- The same stored file is not posted twice to the same network. A repeat is refused.
- `social.status` and `social.post_metrics` are the read-back for whether it posted and how it did. Copy those numbers. Do not estimate them.

`youtube_upload` and `tiktok_upload` in the marketing lane are dry-run stand-ins for a video file. They are not the campaign send. A live TikTok call on that stand-in is refused.

## Formats

The campaign is three formats. Each post names one format and one or more networks that accept it.

| Format | What it carries | Networks |
|---|---|---|
| Text | Caption only. No media file. | Bluesky, Facebook, LinkedIn, Mastodon, Threads, X |
| Photo | A still plus a caption. | Those six, plus Instagram, TikTok, and YouTube |
| Video | An mp4 plus a caption. | Those six, plus Instagram, TikTok, and YouTube |

Instagram, TikTok, and YouTube refuse a text-only post. A post to them must include a `file_id` or a public media URL.

`visibility` (`public`, `unlisted`, `private`) is accepted only by YouTube and Mastodon. A post that also names any other network must omit it. Left unset, the account's own default is used. On a video channel that default is normally public, so a YouTube post that should stay unlisted has to say `unlisted` and name no other network.

Pinterest and Reddit can be connected in the portal. Naïve cannot publish to them yet: a post needs a board or a subreddit, and the post body has no field for that.

## What we take from the media blueprint

The `media` blueprint is Naïve's content-distribution machine: one post queue, three crews (`faceless`, `longform`, `clipping`). We use its teaching and its publisher. We do not install the blueprint.

`naive up` on that blueprint seats its crew on the company board. This studio already has a Studio Head and a roster. A second crew there would take cards on the same board.

Attach these catalogue skills to `social-media-manager`. They are the video half of that blueprint's skill catalogue. A hosted session loads them. The local runner does not.

| Skill | What the media crews use it for |
|---|---|
| `naive/short-video-hooks` | The opening of a short video |
| `naive/clip-selection` | Which stretch of a long video becomes the short |
| `naive/caption-writing` | The caption on a cut |
| `naive/video-assembly` | Joining rendered segments into one file |
| `naive/reference-teardown` | Planning against a reference someone actually watched |
| `naive/video-trend-brief` | What is circulating, from watched references |
| `naive/long-form-arc` | The shape of a long video |
| `naive/channel-report` | The weekly note to the operator |

Vertical cuts of a finished trailer can go through Naïve's clip job (`clip_video` / `POST` clips). It returns short, captioned clips and a virality score. It does not run the game. Footage and stills still come from `media_capture` against the build.

## What the operator connects

Logged as an account step, on the studio identity, not from this dev clone:

1. `POST /v1/identities/{identity}/social/activate`
2. `POST /v1/identities/{identity}/social/portal`, then the account owner opens the URL and connects the networks.
3. `GET /v1/identities/{identity}/social/accounts` until the networks show as connected.

The dev clone has no live post credentials. A real send happens on the studio identity, through the approval gate.

## What the agent hands back

One video, one photo, and one text package, each as a file under `social/` plus the media file for the photo and the video. Every post in the result is `draft`, `dry-run`, or `blocked` until a Naïve `social.post` result says it was accepted. Finance & Compliance clears a public post before that call. A missing public build URL blocks the send. The files can still be prepared.
