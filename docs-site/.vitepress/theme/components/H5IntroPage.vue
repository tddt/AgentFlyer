<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

type SlideMeta = {
  id: string;
  step: string;
  label: string;
};

const slides: SlideMeta[] = [
  { id: 'hero', step: '01', label: '定位' },
  { id: 'pains', step: '02', label: '痛点' },
  { id: 'runtime', step: '03', label: '解法' },
  { id: 'scenarios', step: '04', label: '场景' },
  { id: 'governance', step: '05', label: '治理' },
  { id: 'pilot', step: '06', label: '试点' },
  { id: 'cta', step: '07', label: '收束' },
];

const deckRef = ref<HTMLElement | null>(null);
const currentSlide = ref(0);

let observer: IntersectionObserver | null = null;

function goToSlide(index: number): void {
  const deck = deckRef.value;
  const targets = deck?.querySelectorAll<HTMLElement>('.kp-slide');
  targets?.[index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

onMounted(() => {
  const deck = deckRef.value;
  if (!deck) return;
  const nodes = Array.from(deck.querySelectorAll<HTMLElement>('.kp-slide'));

  observer = new IntersectionObserver(
    (entries) => {
      const best = entries
        .filter((e) => e.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      if (!best) return;
      const idx = nodes.indexOf(best.target as HTMLElement);
      if (idx >= 0) currentSlide.value = idx;
    },
    { root: deck, threshold: [0.5] },
  );

  nodes.forEach((n) => observer?.observe(n));
});

onBeforeUnmount(() => {
  observer?.disconnect();
  observer = null;
});
</script>

<template>
  <div class="kp-root">
    <nav class="kp-dots" aria-label="幻灯片导航">
      <button
        v-for="(s, i) in slides"
        :key="s.id"
        type="button"
        class="kp-dot"
        :class="{ 'is-active': currentSlide === i }"
        :title="s.label"
        :aria-label="`跳转到第 ${i + 1} 页：${s.label}`"
        @click="goToSlide(i)"
      ><span class="kp-dot-inner"></span></button>
    </nav>

    <div class="kp-badge" aria-live="polite">
      <span class="kp-badge-step">{{ slides[currentSlide].step }}</span>
      <span class="kp-badge-sep"> / </span>
      <span class="kp-badge-total">07</span>
    </div>

    <div ref="deckRef" class="kp-deck">

      <!-- 01 Hero -->
      <section class="kp-slide kp-slide-hero" :class="{ 'is-active': currentSlide === 0 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner">
          <p class="kp-eyebrow kp-appear kp-d1">企业 Agent 运行时</p>
          <h1 class="kp-hero-hl kp-appear kp-d2">从<em>会回答</em>，<br>到<em>能运行</em></h1>
          <p class="kp-hero-sub kp-appear kp-d3">
            AgentFlyer 把多 Agent 协作、Workflow、Deliverables、Approval、MCP、Sandbox
            与控制面放进同一套 runtime，让 AI 真正进入企业流程。
          </p>
          <div class="kp-chips kp-appear kp-d4">
            <span>组织系统</span><span>流程闭环</span><span>结果资产化</span>
          </div>
          <button type="button" class="kp-cta-btn kp-appear kp-d5" @click="goToSlide(1)">了解企业痛点 →</button>
        </div>
        <div class="kp-hero-deco" aria-hidden="true">
          <div class="kp-ring kp-ring-1"></div>
          <div class="kp-ring kp-ring-2"></div>
          <div class="kp-ring kp-ring-3"></div>
          <div class="kp-orb"></div>
        </div>
      </section>

      <!-- 02 Pains -->
      <section class="kp-slide kp-slide-pains" :class="{ 'is-active': currentSlide === 1 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner">
          <p class="kp-eyebrow kp-appear kp-d1">02 · Enterprise Pains</p>
          <h2 class="kp-section-hl kp-appear kp-d2">很多企业已接入 AI，但 AI 还没进入真正的业务流程。</h2>
          <div class="kp-pain-grid kp-appear kp-d3">
            <article class="kp-pain-card">
              <span class="kp-pain-num">P1</span>
              <h3>AI 只能回答，不能推进复杂任务</h3>
              <p>多角色协作、交叉验证和结果审阅需要系统结构，不只是单轮问答。</p>
            </article>
            <article class="kp-pain-card">
              <span class="kp-pain-num">P2</span>
              <h3>结果散落在对话里，难以沉淀复用</h3>
              <p>企业需要方案、报告、纪要，而不是"聊完了"的聊天记录。</p>
            </article>
            <article class="kp-pain-card">
              <span class="kp-pain-num">P3</span>
              <h3>审批与权限边界无法落地</h3>
              <p>一旦接入工具或系统，组织会追问谁批准、谁追踪、谁负责。</p>
            </article>
            <article class="kp-pain-card">
              <span class="kp-pain-num">P4</span>
              <h3>PoC 常成功，生产落地常失速</h3>
              <p>试点展示了模型能力，却没有回答系统如何被组织长期使用。</p>
            </article>
          </div>
        </div>
        <div class="kp-pains-deco" aria-hidden="true">
          <div class="kp-slash kp-slash-1"></div>
          <div class="kp-slash kp-slash-2"></div>
        </div>
      </section>

      <!-- 03 Runtime -->
      <section class="kp-slide kp-slide-runtime" :class="{ 'is-active': currentSlide === 2 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner kp-split">
          <div class="kp-split-l">
            <p class="kp-eyebrow kp-appear kp-d1">03 · Runtime Solution</p>
            <h2 class="kp-section-hl kp-appear kp-d2">AgentFlyer 解决的是企业 Agent 的<em>运行时问题</em>。</h2>
            <p class="kp-body kp-appear kp-d3">
              企业真正需要的不是更会说话的模型，而是一套能把执行、状态、流程、控制和结果组织起来的 runtime。
            </p>
            <ol class="kp-pipeline kp-appear kp-d4">
              <li><strong>Agents</strong><span>coordinator、analyst、specialist、reviewer 各司其职</span></li>
              <li><strong>Workflow</strong><span>可调度、可重复、可观察的流程编排</span></li>
              <li><strong>Deliverables</strong><span>输出从聊天内容升级为正式业务产物</span></li>
              <li><strong>Control Plane</strong><span>审批、恢复、执行历史与状态全可见</span></li>
            </ol>
          </div>
          <div class="kp-split-r kp-appear kp-d3">
            <div class="kp-modules">
              <div class="kp-mod"><span class="kp-mod-tag">Control</span><strong>Console UI + CLI</strong><p>企业需要能看、能控、能接管的操作表面。</p></div>
              <div class="kp-mod"><span class="kp-mod-tag">State</span><strong>Sessions + Memory + Deliverables</strong><p>让会话、记忆和成果被系统持续承接。</p></div>
              <div class="kp-mod"><span class="kp-mod-tag">Execution</span><strong>Approval + MCP + Sandbox</strong><p>让系统接入具备边界、审批和治理。</p></div>
            </div>
          </div>
        </div>
      </section>

      <!-- 04 Scenarios -->
      <section class="kp-slide kp-slide-scenarios" :class="{ 'is-active': currentSlide === 3 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner">
          <p class="kp-eyebrow kp-appear kp-d1">04 · Best-fit Scenarios</p>
          <h2 class="kp-section-hl kp-appear kp-d2">优先从高频、高痛、结果明确的场景切入</h2>
          <div class="kp-scen-grid kp-appear kp-d3">
            <article class="kp-scen-card">
              <div class="kp-scen-icon">✦</div>
              <span class="kp-scen-tag">售前 · 方案团队</span>
              <h3>售前与方案协作流</h3>
              <p>把客户背景、行业信息和案例整合成结构化方案，再由 reviewer agent 做一致性审查。</p>
              <div class="kp-scen-out">典型输出：方案文档 / 答标材料 / 行业洞察</div>
            </article>
            <article class="kp-scen-card">
              <div class="kp-scen-icon">◆</div>
              <span class="kp-scen-tag">战略 · 产品 · 管理支持</span>
              <h3>调研与决策支持</h3>
              <p>多来源采集、摘要、对比与证据缺口标注，最终交付管理层正式结论。</p>
              <div class="kp-scen-out">典型输出：研究简报 / 专题报告 / 决策备忘录</div>
            </article>
            <article class="kp-scen-card">
              <div class="kp-scen-icon">▲</div>
              <span class="kp-scen-tag">运营 · PMO · 项目组</span>
              <h3>运营与项目推进</h3>
              <p>任务拆解、进度跟踪、异常补充与结果汇总形成连续流程，不再靠人工手工拼接。</p>
              <div class="kp-scen-out">典型输出：周报 / 复盘 / 推进纪要 / 行动列表</div>
            </article>
          </div>
        </div>
      </section>

      <!-- 05 Governance -->
      <section class="kp-slide kp-slide-governance" :class="{ 'is-active': currentSlide === 4 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner">
          <p class="kp-eyebrow kp-appear kp-d1">05 · Governance</p>
          <h2 class="kp-section-hl kp-appear kp-d2">真正让 Agent 进入企业的，不是更多接口，而是更清晰的边界。</h2>
          <div class="kp-gov-grid kp-appear kp-d3">
            <article class="kp-gov-card">
              <div class="kp-gov-lbl">Approval</div>
              <h3>高风险动作需要人工确认</h3>
              <p>企业担心的不是 AI 不够聪明，而是做错事时没人知道、没人接管。</p>
            </article>
            <article class="kp-gov-card">
              <div class="kp-gov-lbl">Sandbox</div>
              <h3>工具执行在受控环境中运行</h3>
              <p>不是默认继承宿主机全部权限，而是按边界和策略逐步开放能力。</p>
            </article>
            <article class="kp-gov-card">
              <div class="kp-gov-lbl">MCP</div>
              <h3>外部系统接入收敛到统一治理层</h3>
              <p>减少碎片化工具接入，把生命周期、状态和可观察性收回系统边界。</p>
            </article>
            <article class="kp-gov-card">
              <div class="kp-gov-lbl">Control Plane</div>
              <h3>Console UI 与 CLI 提供真实操作面</h3>
              <p>会话、流程、交付物、调度与审批都不是隐藏在日志里的内部状态。</p>
            </article>
          </div>
        </div>
        <div class="kp-gov-deco" aria-hidden="true"></div>
      </section>

      <!-- 06 Pilot -->
      <section class="kp-slide kp-slide-pilot" :class="{ 'is-active': currentSlide === 5 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner kp-split">
          <div class="kp-split-l">
            <p class="kp-eyebrow kp-appear kp-d1">06 · Pilot Plan</p>
            <h2 class="kp-section-hl kp-appear kp-d2">不要先做"大平台"，先从一个高价值场景跑通。</h2>
            <p class="kp-body kp-appear kp-d3">
              最有效的路径：围绕一个足够痛、足够高频的业务问题，在 2–6 周内做出能运行、能观察、能复盘的试点，再决定如何横向扩展。
            </p>
          </div>
          <ol class="kp-ladder kp-appear kp-d3">
            <li><span class="kp-lnum">01</span><div><h3>选一个单场景试点</h3><p>优先选择高频、重复、人工成本高、结果可比较的任务。</p></div></li>
            <li><span class="kp-lnum">02</span><div><h3>梳理角色、输入、审批与交付物</h3><p>明确谁是 coordinator，哪些输入来自系统，最终要沉淀什么结果。</p></div></li>
            <li><span class="kp-lnum">03</span><div><h3>在 AgentFlyer 中搭建可运行流程</h3><p>把多 Agent 协作、Workflow、Deliverables 和控制面组织成完整链路。</p></div></li>
            <li><span class="kp-lnum">04</span><div><h3>用结果说话，再横向复制</h3><p>验证效率、稳定性与组织接受度后，扩展到更多相邻流程。</p></div></li>
          </ol>
        </div>
      </section>

      <!-- 07 CTA -->
      <section class="kp-slide kp-slide-cta" :class="{ 'is-active': currentSlide === 6 }">
        <div class="kp-noise"></div>
        <div class="kp-slide-inner kp-cta-inner">
          <p class="kp-eyebrow kp-appear kp-d1">07 · Next Steps</p>
          <h2 class="kp-cta-hl kp-appear kp-d2">企业需要的不是又一个 Demo，<br>而是一套可持续演进的<em>Agent 运行机制</em>。</h2>
          <div class="kp-outcomes kp-appear kp-d3">
            <div class="kp-out"><span class="kp-out-icon">⬡</span><strong>一套能持续运行的底座</strong><span>不是一次性展示页，不是难以继承的临时脚本。</span></div>
            <div class="kp-out"><span class="kp-out-icon">⬡</span><strong>一类可复制的流程模板</strong><span>把试点经验沉淀成可扩展的组织能力。</span></div>
            <div class="kp-out"><span class="kp-out-icon">⬡</span><strong>一层可治理的系统接入方式</strong><span>让 AI 能力进入企业时，不再只有"能不能接"这一个问题。</span></div>
          </div>
          <div class="kp-actions kp-appear kp-d4">
            <a class="kp-btn kp-btn-p" href="/zh/guide/getting-started">开始使用</a>
            <a class="kp-btn kp-btn-o" href="/zh/use-cases">适用场景</a>
            <a class="kp-btn kp-btn-o" href="/zh/comparison">对比分析</a>
            <a class="kp-btn kp-btn-g" href="https://github.com/tddt/AgentFlyer" target="_blank" rel="noopener">GitHub ↗</a>
          </div>
        </div>
        <div class="kp-cta-deco" aria-hidden="true">
          <div class="kp-cta-ring kp-cta-r1"></div>
          <div class="kp-cta-ring kp-cta-r2"></div>
        </div>
      </section>

    </div>
  </div>
</template>
