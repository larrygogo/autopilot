// 由 scripts/gen-migrations-index.ts 生成，勿手改。加迁移用 `autopilot migrate new` 会自动重跑本脚本。
import type { Database } from "bun:sqlite";
import * as m0 from "./001-baseline";
import * as m1 from "./002-schedules";
import * as m2 from "./004-repos";
import * as m3 from "./005-requirements";
import * as m4 from "./006-submodules";
import * as m5 from "./007-workflows";
import * as m6 from "./008-projects";
import * as m7 from "./009-nullable-codebase";
import * as m8 from "./010-question-suggestions";
import * as m9 from "./011-now-dismissed-cards";
import * as m10 from "./012-spec-revisions";
import * as m11 from "./013-active-question-id";
import * as m12 from "./014-resolve-orphan-open-questions";
import * as m13 from "./015-clarifier-error";
import * as m14 from "./016-requirement-clarifier-override";
import * as m15 from "./017-kv";
import * as m16 from "./018-task-phase-events";
import * as m17 from "./019-task-requirement-id";
import * as m18 from "./020-users";
import * as m19 from "./021-requirement-comments";
import * as m20 from "./022-schedules-send-prompt";
import * as m21 from "./023-backfill-orphan-task-requirements";
import * as m22 from "./024-codebase-to-workspace";
import * as m23 from "./025-one-workspace-per-project";
import * as m24 from "./026-requirement-schedule-error";
import * as m25 from "./027-fix-requirement-sub-prs-fk";
import * as m26 from "./028-requirement-status-reason";
import * as m27 from "./029-requirement-status-before-terminal";
import * as m28 from "./030-requirement-status-logs";
import * as m29 from "./031-requirement-workflow";
import * as m30 from "./032-requirement-attachments";
import * as m31 from "./033-workspace-remote-url";
import * as m32 from "./034-requirement-sessions";
import * as m33 from "./035-notifications";
import * as m34 from "./036-drop-now-dismissed";
import * as m35 from "./037-multi-workspace-per-project";
import * as m36 from "./038-sub-pr-review-watermark";
import * as m37 from "./039-sub-pr-ci-watermark";
import * as m38 from "./040-drop-schedules";
import * as m39 from "./041-api-keys";
import * as m40 from "./042-close-orphan-phase-events";
import * as m41 from "./043-workspace-id-demote-backfill";
import * as m42 from "./044-task-run-columns";
import * as m43 from "./045-requirement-input-mode";
import * as m44 from "./046-requirement-deliveries";
import * as m45 from "./047-providers-table";
import * as m46 from "./048-workflow-kind-spec-json";
import * as m47 from "./049-seed-native-products";
import * as m48 from "./050-requirement-source-fields";
import * as m49 from "./051-workspace-path-nullable";
import * as m50 from "./052-import-file-workflows";
import * as m51 from "./053-drop-yaml-content";

export interface MigrationEntry { version: number; name: string; up: (db: Database) => unknown; }

export const MIGRATIONS: MigrationEntry[] = [
  { version: 1, name: "001-baseline", up: m0.up as MigrationEntry["up"] },
  { version: 2, name: "002-schedules", up: m1.up as MigrationEntry["up"] },
  { version: 4, name: "004-repos", up: m2.up as MigrationEntry["up"] },
  { version: 5, name: "005-requirements", up: m3.up as MigrationEntry["up"] },
  { version: 6, name: "006-submodules", up: m4.up as MigrationEntry["up"] },
  { version: 7, name: "007-workflows", up: m5.up as MigrationEntry["up"] },
  { version: 8, name: "008-projects", up: m6.up as MigrationEntry["up"] },
  { version: 9, name: "009-nullable-codebase", up: m7.up as MigrationEntry["up"] },
  { version: 10, name: "010-question-suggestions", up: m8.up as MigrationEntry["up"] },
  { version: 11, name: "011-now-dismissed-cards", up: m9.up as MigrationEntry["up"] },
  { version: 12, name: "012-spec-revisions", up: m10.up as MigrationEntry["up"] },
  { version: 13, name: "013-active-question-id", up: m11.up as MigrationEntry["up"] },
  { version: 14, name: "014-resolve-orphan-open-questions", up: m12.up as MigrationEntry["up"] },
  { version: 15, name: "015-clarifier-error", up: m13.up as MigrationEntry["up"] },
  { version: 16, name: "016-requirement-clarifier-override", up: m14.up as MigrationEntry["up"] },
  { version: 17, name: "017-kv", up: m15.up as MigrationEntry["up"] },
  { version: 18, name: "018-task-phase-events", up: m16.up as MigrationEntry["up"] },
  { version: 19, name: "019-task-requirement-id", up: m17.up as MigrationEntry["up"] },
  { version: 20, name: "020-users", up: m18.up as MigrationEntry["up"] },
  { version: 21, name: "021-requirement-comments", up: m19.up as MigrationEntry["up"] },
  { version: 22, name: "022-schedules-send-prompt", up: m20.up as MigrationEntry["up"] },
  { version: 23, name: "023-backfill-orphan-task-requirements", up: m21.up as MigrationEntry["up"] },
  { version: 24, name: "024-codebase-to-workspace", up: m22.up as MigrationEntry["up"] },
  { version: 25, name: "025-one-workspace-per-project", up: m23.up as MigrationEntry["up"] },
  { version: 26, name: "026-requirement-schedule-error", up: m24.up as MigrationEntry["up"] },
  { version: 27, name: "027-fix-requirement-sub-prs-fk", up: m25.up as MigrationEntry["up"] },
  { version: 28, name: "028-requirement-status-reason", up: m26.up as MigrationEntry["up"] },
  { version: 29, name: "029-requirement-status-before-terminal", up: m27.up as MigrationEntry["up"] },
  { version: 30, name: "030-requirement-status-logs", up: m28.up as MigrationEntry["up"] },
  { version: 31, name: "031-requirement-workflow", up: m29.up as MigrationEntry["up"] },
  { version: 32, name: "032-requirement-attachments", up: m30.up as MigrationEntry["up"] },
  { version: 33, name: "033-workspace-remote-url", up: m31.up as MigrationEntry["up"] },
  { version: 34, name: "034-requirement-sessions", up: m32.up as MigrationEntry["up"] },
  { version: 35, name: "035-notifications", up: m33.up as MigrationEntry["up"] },
  { version: 36, name: "036-drop-now-dismissed", up: m34.up as MigrationEntry["up"] },
  { version: 37, name: "037-multi-workspace-per-project", up: m35.up as MigrationEntry["up"] },
  { version: 38, name: "038-sub-pr-review-watermark", up: m36.up as MigrationEntry["up"] },
  { version: 39, name: "039-sub-pr-ci-watermark", up: m37.up as MigrationEntry["up"] },
  { version: 40, name: "040-drop-schedules", up: m38.up as MigrationEntry["up"] },
  { version: 41, name: "041-api-keys", up: m39.up as MigrationEntry["up"] },
  { version: 42, name: "042-close-orphan-phase-events", up: m40.up as MigrationEntry["up"] },
  { version: 43, name: "043-workspace-id-demote-backfill", up: m41.up as MigrationEntry["up"] },
  { version: 44, name: "044-task-run-columns", up: m42.up as MigrationEntry["up"] },
  { version: 45, name: "045-requirement-input-mode", up: m43.up as MigrationEntry["up"] },
  { version: 46, name: "046-requirement-deliveries", up: m44.up as MigrationEntry["up"] },
  { version: 47, name: "047-providers-table", up: m45.up as MigrationEntry["up"] },
  { version: 48, name: "048-workflow-kind-spec-json", up: m46.up as MigrationEntry["up"] },
  { version: 49, name: "049-seed-native-products", up: m47.up as MigrationEntry["up"] },
  { version: 50, name: "050-requirement-source-fields", up: m48.up as MigrationEntry["up"] },
  { version: 51, name: "051-workspace-path-nullable", up: m49.up as MigrationEntry["up"] },
  { version: 52, name: "052-import-file-workflows", up: m50.up as MigrationEntry["up"] },
  { version: 53, name: "053-drop-yaml-content", up: m51.up as MigrationEntry["up"] },
];
