"""Run with python scripts/test-evidence-worker.py. Uses an isolated temporary database."""
import base64, io, json, subprocess, sys, tempfile, unittest
from pathlib import Path
from reportlab.pdfgen import canvas
WORKER=Path(__file__).with_name("evidence-worker.py")
def invoke(**request):
 result=subprocess.run([sys.executable,str(WORKER)],input=json.dumps(request),capture_output=True,text=True)
 return json.loads(result.stdout)
class EvidenceTest(unittest.TestCase):
 def test_database_read_insert_update_and_rejected_write(self):
  with tempfile.TemporaryDirectory() as folder:
   common={"databasePath":str(Path(folder)/"ledger.sqlite")}
   read=invoke(action="read",paymentCode="B-204",**common)
   self.assertEqual(read["records"][0]["name"],"Client B")
   self.assertEqual(invoke(action="read",paymentCode="B-204' OR 1=1 --",**common)["records"],[])
   original=invoke(action="insert",owner="Client A",bankLine="1042",**common)
   draft_id=original["draft"]["id"]
   updated=invoke(action="update",draftId=draft_id,owner="Client B",bankLine="1042",**common)
   self.assertEqual(updated["draft"]["id"],draft_id)
   self.assertFalse(updated["draft"]["ledgerPosted"])
   self.assertEqual(updated["record"]["changes"][0],{"field":"client","before":"Client A","after":"Client B"})
   self.assertIn("error",invoke(action="update",draftId=draft_id,owner="Unknown",bankLine="1042",**common))
   import sqlite3
   from contextlib import closing
   with closing(sqlite3.connect(common["databasePath"])) as db:
    self.assertEqual(db.execute("SELECT client FROM allocation_drafts WHERE id=?",(draft_id,)).fetchone()[0],"Client B")
 def test_real_multipage_pdf_and_text_bounds(self):
  data=io.BytesIO();pdf=canvas.Canvas(data)
  pdf.drawString(50,700,"First page");pdf.showPage();pdf.drawString(50,700,"Payment B-204");pdf.showPage();pdf.save()
  request={"action":"pdf","bytes":base64.b64encode(data.getvalue()).decode()}
  result=invoke(**request,pageNumber=2,pattern="Payment B-204")
  self.assertEqual(result["value"],"Payment B-204");self.assertEqual(result["pageCount"],2)
  self.assertTrue(all(0<=x<=1 for x in result["region"].values()))
  self.assertTrue(base64.b64decode(result["pngBase64"]).startswith(b"\x89PNG"))
  self.assertIn("error",invoke(**request,pageNumber=3))
  self.assertEqual(invoke(**request,pageNumber=1,pattern="Payment B-204")["matchCount"],0)
 def test_ambiguous_text_and_scan_rejected(self):
  data=io.BytesIO();pdf=canvas.Canvas(data);pdf.drawString(50,700,"Repeated");pdf.drawString(50,650,"Repeated");pdf.showPage();pdf.showPage();pdf.save()
  request={"action":"pdf","bytes":base64.b64encode(data.getvalue()).decode()}
  result=invoke(**request,pattern="Repeated")
  self.assertEqual(result["matchCount"],2);self.assertIsNone(result["region"])
  self.assertIn("no extractable text",invoke(**request,pageNumber=2)["error"])
if __name__=="__main__":unittest.main()
