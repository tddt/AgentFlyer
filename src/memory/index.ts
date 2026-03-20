export { MemoryStore, type MemoryEntry } from './store.js';
export { embed, cosineSimilarity, resetPipeline, type EmbedConfig } from './embed.js';
export { searchMemory, type SearchResult, type SearchOptions } from './search.js';
export { syncMemoryDir, watchMemoryDir, type MemorySyncWatcher } from './sync.js';
export { decayScore, ageInDays } from './decay.js';
export { sharedPartition, agentPartition, partitionsForAgent, type MemoryPartition } from './partition.js';
