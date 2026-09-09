import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { executeSql, sqlLiteral } from "./manage-admin.js";
import { normalizeAccessEmail } from "../worker/src/security/access-email.js";

export const usage = "npm run admin:create-access -- --email EMAIL --role moderator|admin (--local | --remote) [--execute]";
export function parseArguments(argv) {
  const options={email:null,role:"moderator",target:null,execute:false};
  const seen=new Set();
  for(let i=0;i<argv.length;i++) {
    const key=argv[i];
    if(seen.has(key)) throw new Error("Duplicate option.");
    seen.add(key);
    if(key==="--execute") { options.execute=true; continue; }
    if(key==="--local"||key==="--remote") {
      if(options.target) throw new Error("Choose exactly one database target.");
      options.target=key.slice(2); continue;
    }
    if(!["--email","--role"].includes(key)) throw new Error("Unsupported option.");
    const value=argv[++i];
    if(!value||value.startsWith("--")) throw new Error("Missing option value.");
    if(key==="--email") options.email=normalizeAccessEmail(value);
    else options.role=value;
  }
  if(!options.email||!options.target) throw new Error("Explicit email and database target required.");
  if(!["admin","moderator"].includes(options.role)) throw new Error("Role must be admin or moderator. Owner creation is not supported.");
  return options;
}
export async function runCli(argv,{
  query=request=>executeSql({...request,json:true}),
  execute=request=>executeSql(request,{stdout:{write() {}},stderr:{write() {}}}),
  logger=console
}={}) {
  const options=parseArguments(argv);
  // This lookup contains an email, never credentials. Remote --file performs
  // an import and returns metrics, not SELECT rows; use --command --json.
  // Keep the actual mutation below on the protected, atomic file path.
  const rows=await query({target:options.target,sql:`SELECT id FROM admins WHERE access_email_normalized=${sqlLiteral(options.email)};`,sensitive:false,sensitiveValues:[options.email]});
  if(!Array.isArray(rows)) throw new Error("Invalid database result.");
  if(rows.length) throw new Error("Duplicate Access email.");
  logger.log(`Target: ${options.target}; new Access-only admin; email ${options.email}; role ${options.role}; enabled=true. No GitHub or password identity.`);
  logger.log("Planned mutation: INSERT admins + INSERT audit_logs (atomic); existing admins unchanged. New admin ID assigned only on execute.");
  if(!options.execute) {logger.log("Preview only. Add --execute to create. No database changes.");return;}
  // One atomic D1 file operation. UNIQUE also rejects a concurrent create.
  const sql=`INSERT INTO admins(access_email,role,enabled) VALUES(${sqlLiteral(options.email)},${sqlLiteral(options.role)},1);
    INSERT INTO audit_logs(admin_id,action,metadata) VALUES(NULL,'admin_access_created',
      json_object('source','create-access-cli','target_admin_id',last_insert_rowid(),'role',${sqlLiteral(options.role)},'provider','cloudflare_access'));`;
  try { await execute({target:options.target,sql,sensitive:true,sensitiveValues:[options.email]}); }
  catch { throw new Error("Access admin creation failed or outcome unavailable. Database errors roll back; after a transport error inspect admins and audit before retrying."); }
  logger.log("Access-only admin created and audited. Access exact-email allowlist must be configured separately.");
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {await runCli(process.argv.slice(2));}
  catch(error) {console.error(error.message);console.error(usage);process.exitCode=1;}
}
