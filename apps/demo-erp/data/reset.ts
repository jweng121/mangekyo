import {resetState} from "../lib/store";
const seed=Number(process.env.DEMO_ERP_SEED||42);
resetState(seed).then(()=>console.log(`Demo ERP reset to seed ${seed}`));
