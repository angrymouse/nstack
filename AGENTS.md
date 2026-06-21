# Agent Instructions

This repository builds the `nstack` CLI and project templates.

## Versioning

Bump the package version in `package.json` for every repository change or commit.

## Prose Style

Avoid binary contrast phrasing in prose, web design, reasoning, and
documentation. The construction `it's not just <X>, it's <other, actual
meaning>` and close variants such as `it is not just...` are very strongly
discouraged. State the direct claim or tradeoff without that rhetorical
construction.
Also avoid chained negation followed by one asserted answer, such as `This is
not a coincidence. That is not numerology. That is *structure*.` Prefer one
clear positive statement.
Avoid empty rule-of-three cadence used for rhetorical lift without substance,
such as `They absorbed it. They adapted. They kept working.` Use one concrete
sentence instead.
Do not use em dashes. Avoid dot-style bullet presentation, including decorative
bullet glyphs such as `•` and markdown bullets used for rhetorical emphasis.
Do not treat this as a punctuation swap by replacing an em dash with a hyphen
while keeping the same padded sentence structure. Hyphens are fine when they
serve normal grammar; revise sentence shape, pacing, and information order.
Avoid bullet points by default unless the user specifically asks for them or the
content is naturally a technical list, checklist, command sequence, or reference
table that benefits from scanning. Prefer short paragraphs when bullets add no
clear value.
Avoid filler words and padded lead-ins that are uncommon in normal technical
conversation, such as `elevate`, `delve`, and `tackle`. Cut low-information
sentences, especially parallel sentence structures that delay the useful point.
Before sending prose, reread it and rewrite when it feels wordy, watery, or
ceremonial.
Avoid technical detail in prose and frontend copy unless it adds value in that
specific paragraph or screen. Keep details that help the reader decide, act, or
understand current state. Remove implementation facts that only make copy sound
more technical.
Avoid decorative badges, status pills, pulsing dots, and tiny uppercase
subtitles when they do not carry real product or workflow meaning. Labels such
as `LIVE`, `Open Source`, or section eyebrows should earn their place; otherwise
remove them and let the heading or body copy do the work.
For website and frontend copy, check every visible line after editing. Each line
should tell the user what the product is, what they can do, what changed, or what
command to run. Replace buzzphrases such as `Ship from the directory you already
use` with concrete wording that names the real action.
Do not dress an obvious instruction up as product copy. Plain wording such as
`Install nstack` is better than a sentence that tries to sound pragmatic but
adds no new information. If a line only restates what the user already knows,
delete it or replace it with the next useful action. Avoid lines like `Install
nstack, then set up each app.` because they restate the workflow without adding
the command or decision the reader needs. Do not include installer internals such
as linking the CLI into `~/.local/bin` unless the reader is troubleshooting that
specific failure.
Before keeping any prose, test each sentence on its own. Ask whether it belongs
on this page, whether it describes a common or recommended path, whether the
surrounding docs have introduced that context, and whether it gives the reader a
real next action, decision, or state. If a sentence such as `For a cloned
generated app, run nstack setup before nstack dev or nstack deploy.` appears in
an install section that does not recommend cloning generated apps, delete it
instead of polishing it. For long paragraphs, run this check sentence by
sentence even when it feels tedious; do not approve the paragraph as a block.
When you reject a sentence and write a replacement, run the same check on the
replacement. Keep iterating until the wording is just right: on the tip,
concrete, and juicy, with no filler.
Avoid negative capability copy unless the missing requirement is one of the
best selling points or removes a blocker the reader is likely to have. Phrases
such as `No Encore Cloud login is required`, `No sunglasses required`, or `No
sofa required` can be technically true and still give zero useful information.
If the reader is not already worried about that requirement, delete the line or
replace it with what they can do.

## Frontend Design

Treat typography as a main design decision from the first layout pass. Choose a
real design typeface that fits the product, audience, and mood. Favor fit over
novelty; a strong design font can look plain, quiet, and work-focused. Do not
default to standard choices such as Inter, Geist, or the system stack when the
screen needs a more considered type voice. Consider typefaces such as Excon,
Satoshi, Newsreader, Hanken Grotesk, Bricolage Grotesque, Absans, or another
family that fits the subject. Pair display and body fonts deliberately, tune
weights, spacing, and line height, and verify the result on mobile and desktop.

## Template Documentation Maintenance

When changing nstack behavior, CLI flows, deployment semantics, generated files,
resource handling, package-manager behavior, or recommended app workflows, update
the generated app AI docs in the template as part of the same change:

- `templates/encore-nuxt/AGENTS.md`
- `templates/encore-nuxt/NSTACK_GUIDELINES.md`

Keep those files accurate for newly initialized apps. If a framework adjustment
does not affect generated app workflows, no template doc update is needed.
