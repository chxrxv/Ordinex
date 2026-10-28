"""Regenerates the small synthetic fixtures used by the browser tests. Run once; outputs are committed."""
import zipfile, io, shutil, os
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
D = os.path.join(os.path.dirname(__file__), 'fixtures')
shutil.copy(os.path.join(D, '..', '..', 'eval', 'fixtures', 'edge-policy.pdf'), os.path.join(D, 'policy.pdf'))
# scanned-style PDF: a page with no text layer
c = canvas.Canvas(os.path.join(D, 'scanned.pdf')); c.rect(50, 50, 200, 200, fill=1); c.save()
# encrypted PDF
w = PdfWriter(); [w.add_page(p) for p in PdfReader(os.path.join(D, 'policy.pdf')).pages]; w.encrypt('secret'); w.write(os.path.join(D, 'encrypted.pdf'))
# minimal DOCX
paras = ['Incident response: the DPO notifies the supervisory authority within 72 hours of becoming aware of a personal data breach.',
         'All customer personal data is encrypted at rest using AES-256 and in transit with TLS 1.2.']
body = ''.join('<w:p><w:r><w:t>%s</w:t></w:r></w:p>' % p for p in paras)
with zipfile.ZipFile(os.path.join(D, 'policy.docx'), 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>%s</w:body></w:document>' % body)
open(os.path.join(D, 'empty.txt'), 'wb').close()
open(os.path.join(D, 'tool.exe'), 'wb').write(b'MZ\x90\x00fake')
open(os.path.join(D, 'malformed.pdf'), 'wb').write(b'%PDF-1.4\nthis is not really a pdf')
open(os.path.join(D, 'xss.txt'), 'w', encoding='utf8').write('Encryption: data is encrypted at rest using AES-256.\n\n<img src=x onerror="window.__xss=1"> <script>window.__xss=1</script> Backups are encrypted.')
open(os.path.join(D, 'hindi.txt'), 'w', encoding='utf8').write('सभी ग्राहक व्यक्तिगत डेटा AES-256 एन्क्रिप्शन के साथ संग्रहीत किया जाता है। encryption of data at rest.')
shutil.copy(os.path.join(D, '..', '..', 'eval', 'fixtures', 'acme-security-policy.txt'), os.path.join(D, 'injection.txt'))
print(sorted(os.listdir(D)))
