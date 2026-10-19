// Writes a consistent, verified backup of the agent database (VACUUM INTO includes committed WAL pages).
//   npm run db:backup
import { backupDatabase } from "../agent/migrations";

const path = backupDatabase("manual");
console.log(path ? `Backup written and verified: ${path}` : "In-memory database: nothing to back up.");
