# Refuse a field write that cites a page the session never fetched

The research agent's premise is that nothing about a company or a person is
guessed. The system prompt says so, `set_field_value`'s own description says
"leave it blank rather than guess", and the evidence layer exists to make a
claim carry its source. All of it was advice to a model, and none of it was
enforced.

It does not hold. Running a nine-company batch through the enrichment tools, a
company whose site returned nothing (`HTTP 000`, twice) still came out of the
run with an industry, a city, a state code and a positioning paragraph — all
invented, and one of them wrong in the way that matters: a Colorado town filed
under California. Another run wrote a LinkedIn URL, correctly formed from the
company name, that 404s. A third reported field writes in its summary that the
trace shows it never made.

Four of nine runs produced at least one fabricated or wrong field. The failure
mode is not garbled output that a reviewer catches — it is confident, specific,
plausible firmographics, which is the kind a reviewer skims past and a rep later
acts on.

## Two rules, both in the runtime

**A source that cannot be read fails the task.** `research_company` reads a
company's site through `context.dev`'s extract. When that fails — or returns a
200 carrying nothing — the tool no longer hands the model an error string to
reason around. If the unreadable site belongs to the record the task is about,
the task is closed through the ordinary path (`completeTask` then `settle`) with
the outcome `Source unavailable — <url> could not be read (…). Nothing was
written.`, and the session is latched shut against further writes. "No source"
is a correct outcome for a research task, not a failure to work around.

**A write must cite a page this session actually fetched.** Every retrieval
funnels through a small number of functions, and each now records what it read
into session state: `extract` records the URL it pulled, `search` records only
results whose page body actually came back (a hit with a title and no markdown
is a pointer, not a source — the instructions already said so), the brand lookup
records the domain it resolved, and the people lookup records the profile URLs
the vendor tied to a person. `set_field_value` now takes a required `sourceUrl`
and refuses the call unless it names one of those hosts. `write_brief` applies
the same test per evidence item, with our own mailbox and calendar
(`crm.thread-reply`, `crm.signature-block`, `crm.meeting-attendance`) exempt,
because those stand on our own records rather than an outside page.

Both refusals are errors returned to the model, not warnings in a log. The
session state is the check, so the rule holds regardless of which model is
driving the tools — the failure above was one model's, but nothing about it was
specific to that model.

## What this deliberately does not do

It does not verify that the page *says* what the model claims it says; that
would need the page content back at write time. It closes the gap between "read
nothing" and "wrote something specific", which is where the observed damage came
from.

It also matches on host, not on exact URL, because an extract crawls up to eight
pages of a site and citing `/about` after reading the site is honest. A cited
host must equal a fetched one, or be a subdomain of it.

The cost of being wrong in this direction is a blank field and a tool error the
model can read; the cost of being wrong in the other is a wrong address in a
sales CRM that nobody knows is wrong.
