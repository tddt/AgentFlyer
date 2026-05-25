# Federation

Federation is part of AgentFlyer's direction, but it should be described honestly: the architecture is present, while practical multi-host operation is still expanding.

## What is already in the tree

The codebase already contains federation-oriented modules for:

- node identity
- peer representation
- discovery
- transport seams
- memory synchronization foundations

## Why it exists

Federation matters when one runtime is not enough:

- different machines own different tools or data
- operators want separation between environments
- workloads should move closer to the compute or credentials that own them
- a mesh of AgentFlyer instances is more useful than one oversized host

## Current expectation

Treat federation as an active architectural direction, not a finished distributed control plane.

That means:

- the seams are worth designing against now
- the module presence is real
- the production story is still maturing

## Design guidance

- Keep local runtime flows clean first.
- Make state and execution boundaries explicit.
- Avoid hard-coding assumptions that every agent, tool, and memory source lives on one host forever.

## Related pages

- [Architecture](./architecture)
- [Channels](./channels)
- [Memory](./memory)