import {existsSync} from "node:fs";
import {spawn} from "node:child_process";
const app=existsSync("apps/visual-audit-dev/package.json")?"@mangekyo/visual-audit-dev":"@mangekyo/visual-audit-playground";
const child=spawn(process.platform==="win32"?"pnpm.cmd":"pnpm",["--filter",app,"dev","--port","3000"],{stdio:"inherit",shell:process.platform==="win32"});
child.on("exit",code=>{process.exitCode=code??1});
