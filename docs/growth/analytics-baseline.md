# Analytics Baseline

Track only these 3 metrics:

1. **UV**
2. **Conversion** (Star/install/signup)
3. **7-day retention**

## Suggested baseline table

| Date | UV | Source Top 1 | Source Top 2 | Star/Install/Signup | Conversion % | 7d Retention % | Notes |
|---|---:|---|---|---:|---:|---:|---|

## UTM convention

- `utm_source`: x / juejin / zhihu / reddit / hn / discord
- `utm_medium`: social / community / article / video
- `utm_campaign`: launch-w1 / launch-w2 / tutorial-1 / comparison / monthly-report
- `utm_content`: problem-first / scenario-first / comparison-first

Example:

`https://github.com/tddt/AgentFlyer?utm_source=x&utm_medium=social&utm_campaign=launch-w2&utm_content=problem-first`

## Weekly decision rules

- Keep only top 2 channels by **conversion quality** (not only clicks).
- If UV grows but conversion drops, refine positioning and CTA.
- If conversion grows but retention drops, improve onboarding and quick-start clarity.
