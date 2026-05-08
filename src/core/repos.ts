// 向后兼容 shim：repos.ts → codebases.ts（P1 改名，P6 清理）
export {
  Codebase as Repo,
  CreateCodebaseOpts as CreateRepoOpts,
  UpdateCodebaseOpts as UpdateRepoOpts,
  createCodebase as createRepo,
  getCodebaseById as getRepoById,
  getCodebaseByAlias as getRepoByAlias,
  listCodebases as listRepos,
  updateCodebase as updateRepo,
  deleteCodebase as deleteRepo,
  nextCodebaseId as nextRepoId,
} from "./codebases";
