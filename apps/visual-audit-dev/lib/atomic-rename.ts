import {rename} from "node:fs/promises";

// Windows can briefly lock the destination while a live subscriber reads it.
// Keep atomic replacement; never remove the existing file to work around a lock.
export async function atomicRename(source:string,destination:string){
  for(let attempt=0;;attempt++){
    try{await rename(source,destination);return;}
    catch(error){
      if(attempt>=8 || !["EPERM","EACCES","EBUSY"].includes((error as NodeJS.ErrnoException).code??""))throw error;
      await new Promise(resolve=>setTimeout(resolve,25*(attempt+1)));
    }
  }
}
