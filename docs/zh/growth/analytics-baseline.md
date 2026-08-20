# 指标基线

全程只盯 3 个指标：

1. **UV**
2. **转化**（Star/安装/注册）
3. **7 日留存**

## 建议基线表

| 日期 | UV | 来源 Top1 | 来源 Top2 | Star/安装/注册 | 转化率 % | 7 日留存 % | 备注 |
|---|---:|---|---|---:|---:|---:|---|

## UTM 命名规范

- `utm_source`: x / juejin / zhihu / reddit / hn / discord
- `utm_medium`: social / community / article / video
- `utm_campaign`: launch-w1 / launch-w2 / tutorial-1 / comparison / monthly-report
- `utm_content`: problem-first / scenario-first / comparison-first

示例：

`https://github.com/tddt/AgentFlyer?utm_source=x&utm_medium=social&utm_campaign=launch-w2&utm_content=problem-first`

## 周决策规则

- 只保留按“转化质量”排名前 2 的渠道（不只看点击）。
- UV 上升但转化下降：优先优化定位与 CTA。
- 转化上升但留存下降：优先优化上手路径与文档清晰度。
