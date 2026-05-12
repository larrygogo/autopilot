// 向后兼容 shim：repos.ts → codebases.ts（P1 改名，P6 清理）
// 仅 re-export 函数（值），类型请直接从 codebases.ts 导入
export {
  createCodebase as createRepo,
  getCodebaseById as getRepoById,
  getCodebaseByAlias as getRepoByAlias,
  listCodebases as listRepos,
  updateCodebase as updateRepo,
  deleteCodebase as deleteRepo,
  nextCodebaseId as nextRepoId,
} from "./codebases";
