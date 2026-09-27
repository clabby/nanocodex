# CRM graph

The generic CRM interface is `crm_graph`. Nodes contain text and JSON metadata;
links connect two nodes without direction or a semantic label. There is no required
person/company distinction, event type, or relationship vocabulary.

The storage contract is two tables:

- `crm_nodes`: account owner, ID, text, metadata, creation/update timestamps.
- `crm_links`: account owner, sorted endpoint IDs, creation/update timestamps.

A link's composite foreign keys require both endpoints to exist in the same
account. An unordered pair is unique. Node IDs remain stable when text changes.

## Statements and anchors

Search before creating a node for a person, company, or other recurring subject.
Link a small explicit statement to each relevant subject. For example:

```text
[Ada] -- [Ada is friends with Bea] -- [Bea]
[Bea] -- [Bea is Cy's daughter] -- [Cy]
```

The statement expresses meaning and direction; the links only express context.
Do not collapse a long email's mentions into claims that all those people know
each other. Keep the email as a source and create separate supported statements.
A funding announcement, company update, education history, introduction, and
meeting observation all use this same model.

Metadata is a JSON object, at most 16 KiB on native writes. Useful conventions
include `occurred_at`, `origin`, `sources`, `confidence`, and `rationale`. There is
no required semantic category. Omission on edit preserves metadata; an object
replaces it; `{}` clears it. Preserve supplied year/month/day/timestamp precision,
and do not invent a date for an undated relationship. Creation time describes when
the CRM recorded a node, not when its statement occurred.

## Queries

`search` finds text/metadata; `get` reads a node; `save` creates or edits a native
node. `link_save` and `link_delete` connect or disconnect endpoints. `links` and
`neighbors` expose bounded neighborhoods (one link deep by default). `timeline`
returns the selected node and its immediately connected dated context, oldest
first, excluding undated nodes; omit the node ID for an account-wide timeline.
`path` performs bounded graph traversal and returns the statements along the path.
Path depth defaults to six links; the maximum is ten. Searches default to 100
visited nodes and permit at most 500. Neighborhood responses cap returned links
at 2,000 and report truncation when a bound prevents complete traversal.

A path proves connectivity, not friendship or introduction access. Read its
statements and evidence before interpreting it. Bound exhaustion must be reported;
a bounded search that finds nothing does not prove that no path exists. Corrections
can be explicit new statements linked to the earlier statement. The graph does
not automatically resolve contradictory claims or determine which claim is current.

## Existing integrations

Existing CRM records and assertions are backfilled as graph nodes, with their
legacy fields and provenance preserved in metadata. Legacy integrations continue
to write their existing tables, and database triggers synchronize their graph
projections. Existing profile responses expose `graph_node_id`; use that exact ID
when linking a new statement to an existing profile.

Projected nodes are source-managed: edit/delete them through their originating
CRM tools so the graph and existing profile/calendar/email integrations cannot
diverge. Native statements can connect to projected nodes without copying them.
Legacy tables remain a compatibility layer; this release does not physically
replace every existing table or make legacy profile screens read native graph
nodes. New knowledge can use the generic model without adding new typed tables.

Graph links and metadata are private to the account and unavailable through
Connect grants. Saving nodes does not send messages, register calendar events,
run continuous enrichment, or infer personal relationships.
