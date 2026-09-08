import { authorizeAdmin } from "../auth.js";
import { jsonResponse } from "../http.js";

export async function adminDirectoryHandler(_request,env,principal) {
  authorizeAdmin(principal,["owner"]);
  // Explicit projection: never return password hashes, session values or secrets.
  const {results}=await env.DB.prepare(`SELECT id,github_username,username,access_email_normalized,role,enabled,
    github_user_id IS NOT NULL AS has_github,
    password_hash IS NOT NULL AS has_local
    FROM admins ORDER BY id`).all();
  return jsonResponse({ok:true,data:{admins:results.map(row=>({
    id:row.id,identity:row.github_username??row.username??row.access_email_normalized,
    email:row.access_email_normalized,role:row.role,enabled:row.enabled===1,
    providers:[...(row.has_github?["github"]:[]),...(row.has_local?["local"]:[]),...(row.access_email_normalized?["access"]:[])]
  }))}},{headers:{"Cache-Control":"no-store"}});
}
