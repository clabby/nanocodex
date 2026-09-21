# Long active mobile transcripts

The mobile transcript previously published one viewport-relative geometry preference
per loaded row on every scroll offset. The reading-position code then filtered
that entire dictionary repeatedly. Historical message views also subscribed to
every `InboxModel` publication, and the drawer rebuilt on unrelated publications.
Live publication performed retained-row equality and `AgentCard.apply` on MainActor.

The change measures rows in content coordinates and indexes their non-overlapping
vertical bounds only when layout changes. A scroll changes one offset; direct
anchor lookup is constant-time and visible-row lookup uses binary search plus the
visible entries. Message content uses explicit presentation snapshots behind an
equality boundary. The drawer compares lightweight sidebar snapshots and commits
a gesture to its initial direction. Retained-row equality, media preparation and
card application run together off MainActor; publication rejects changed row or
card inputs. Unchanged rows do not invalidate media and transcript projection.

## Reproduction and evidence

- `python3 apple/Tests/InboxModelTests/test_row_geometry.py`: passes against the
  actual app geometry class with 10,000 varying row heights, viewport boundary
  cases, negative offsets, offsets beyond the end, and replacement layout.
- `NANOCODEX_PUBLICATION_BENCHMARK=1 swift test -c release -j 2 --package-path
  apple/InboxCore --filter TranscriptPublication`: 3 tests pass. Includes stale
  card refresh/navigation rejection and unchanged-row publication behavior.
- On the shared Apple Silicon Mac, a warm 8,000-event / 8,000-row transcript
  receiving one additional event, 40 iterations: median old main-actor preparation
  **4.239 ms**, new main-actor launch/validation **0.0129 ms**, worker **4.060 ms**.
  This excludes media preparation (already asynchronous), UI rendering, scheduling
  delay, and frame presentation. It is not an iPhone FPS or end-to-end benchmark.
  The host was shared with other builds; these values characterize this run only.
- The iOS simulator app and UI-test targets build successfully with Xcode 26.5.
- UI regression `testDrawerButtonsAndEdgeSwipePreserveMiddleTranscriptAnchor`
  passes on iOS 18.2 and iOS 26.5 simulators.
- iOS 18.2 also passes `testLongActiveTranscriptDrawerScrollPreservesSelectionAndSearch`,
  `testStreamingGrowthDoesNotMoveReaderInEarlierParagraphs`, and
  `testLongThreadKeepsPlaceAcrossUpdatesHistoryAndForeground`.
- `testScrollingDoesNotRemeasureEveryTranscriptRow` passes on iOS 18.2 with
  500 Markdown messages and an unchanged geometry-publication count while scrolling. Its instrumentation remains a sibling of the native scroll view so
  that it does not replace the scroll view's accessibility node.

## Scope and remaining work

The transcript still uses an eager stack to preserve exact variable-height
history anchors. This change does not bound initial view materialization or solve
all large-transcript memory use. Grouping and worker preparation can still scale
with retained history. Native recycling/virtualization needs measured-height
anchor preservation, including expanded tools, keyboard changes and prepends;
a direct `LazyVStack` substitution is insufficient validation.

No physical-device frame-time improvement or TestFlight deployment is claimed.
