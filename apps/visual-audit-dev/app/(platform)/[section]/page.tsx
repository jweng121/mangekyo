import {notFound,redirect} from "next/navigation";
import Workspace from "../../Workspace";
export default async function Page({params}:{params:Promise<{section:string}>}){const {section}=await params;if(section==="chat")redirect("/desk?chat=open");if(!["activity","workflows","agents","cash","ledgers","escalations","bookkeeping"].includes(section))notFound();return <Workspace section={section}/>;}
