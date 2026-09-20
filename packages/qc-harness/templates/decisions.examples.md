# Decision examples — not shipped into a new repository

These are the domain decisions from the repository this kit was extracted from. They are here as
worked examples of the register's shape: a decision states the rule it imposes, in one line, and
names something a check can see. Copy the shape, not the content.

They are deliberately **not** in `decisions.md`: a new repository that carried them would be citing
decisions it never made, and the citations gate would be enforcing somebody else's domain.

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0006 | Pin coordinates are normalized page fractions | Never pixels. One screen-to-page helper |
| ADR-0009 | Offline conflicts resolve last-write-wins on the server clock | Per field for free-form values, per item for checklist results. The losing value is kept for audit |
| ADR-0013 | Photo authenticity is a stored hash chain computed at ingest | Never recomputed on the device |
| ADR-0033 | Photos are range-partitioned by capture month | A row outside every partition is rejected, never silently routed |
| QC-004 | The canvas renders with GPU instancing and a 2D overlay | One instanced mesh per archetype. Text and IME stay on the 2D layer. Hit-testing is a quadtree, never a hidden render pass |
| QC-005 | ECS data discipline applies to any hot loop; the registry only to the canvas | Trigger: per frame, or over a threshold count of items, or allocating per iteration on the interaction thread. Asserted by allocation measurement |
| QC-006 | Visual parity with the predecessor is the default | Divergence is argued in the work order, with a before and after |
| QC-009 | Identity externalizes tenancy and quota to a control plane | The access token carries identity only. Tenant memberships, roles and quota live in the control plane and are queried by the edge service |

## What makes one of these a good entry

- **It names the rule, not the reasoning.** The reasoning belongs in the doc the rule points to.
- **A check can see it.** "Never pixels" is greppable. "Coordinates should be sensible" is not.
- **It is one line.** A decision that needs a paragraph is two decisions, or it is a doc.
