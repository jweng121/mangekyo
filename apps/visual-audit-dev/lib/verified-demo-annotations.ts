import type {Snapshot} from "../../../packages/contracts";

// Manually verified region on this exact synthetic scanned PDF, not OCR output.
// Hash gating prevents applying template coordinates to a different document.
export function withVerifiedDemoAnnotations(snapshot:Snapshot):Snapshot {
  if(snapshot.annotations?.length || snapshot.sourceDocument?.sha256!=="48c6095a5da1e545d57f6bc25a9728d108a70970ffdc0855e3148267368ed8cd")return snapshot;
  const evidence=snapshot.evidence.find(item=>item.id===snapshot.id+"-basis");
  if(!evidence)return snapshot;
  return {...snapshot,annotations:[{id:snapshot.id+"-fee-clause",snapshotId:snapshot.id,evidenceRef:evidence.id,label:"Fee after allocated costs",pageNumber:1,region:{x:.095,y:.365,width:.80,height:.076}}]};
}
