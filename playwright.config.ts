import {defineConfig} from "@playwright/test";
export default defineConfig({testDir:"./tests/e2e",use:{baseURL:"http://localhost:3001",viewport:{width:1440,height:900}},webServer:{command:"pnpm.cmd dev:demo-erp",url:"http://localhost:3001",reuseExistingServer:true,timeout:120000}});
