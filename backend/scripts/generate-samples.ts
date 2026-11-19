import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, Footer, Header, Packer, Paragraph, TextRun } from 'docx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { seededRandom } from '../src/lib/vector.js';

/** Synthetic corpus: four topics with shared vocabulary, rendered as PDFs (with running headers/footers), DOCX and TXT. */
export const TOPICS: Record<string, { title: string; sentences: string[] }> = {
  contracts: {
    title: 'Supplier Agreement',
    sentences: [
      'The supplier shall deliver the goods in accordance with the agreed delivery schedule and incoterms.',
      'Payment terms are net sixty days from the date of a correct and undisputed invoice.',
      'Either party may terminate this agreement with ninety days written notice to the other party.',
      'The supplier warrants that all components conform to the specifications listed in the annex.',
      'Liability for indirect or consequential damages is excluded to the extent permitted by law.',
      'Price adjustments require written approval from the procurement department and the category manager.',
      'The supplier must maintain adequate insurance coverage for product liability throughout the term.',
      'Disputes arising from this agreement are subject to arbitration in the agreed jurisdiction.',
      'Confidential information disclosed under this agreement shall not be shared with third parties.',
      'Purchase orders issued under this framework agreement reference the contract number and pricing schedule.',
      'Late delivery entitles the buyer to liquidated damages of one percent per week of delay.',
      'The supplier shall notify the buyer of any change in manufacturing location or sub-suppliers.',
    ],
  },
  maintenance: {
    title: 'Lithography Maintenance Procedure',
    sentences: [
      'Before starting maintenance, lock out the wafer stage and verify that the laser source is powered down.',
      'Replace the reticle handler gripper pads after every two thousand exchange cycles.',
      'Calibrate the alignment sensor using the reference wafer and record the overlay offsets.',
      'Inspect the immersion hood for contamination and clean it with the approved solvent wipes.',
      'Check the vacuum levels of the wafer table and compare them with the service specification.',
      'The illuminator optics must be purged with clean dry air for thirty minutes after opening.',
      'Log all replaced parts in the service report together with the module serial numbers.',
      'Run the focus and leveling diagnostics after any intervention on the projection lens.',
      'Thermal stabilization of the machine requires four hours before production qualification.',
      'Verify the interferometer readings and recalibrate the stage position if drift exceeds tolerance.',
      'Wear an electrostatic discharge wrist strap when handling the sensor boards.',
      'Escalate recurring stage errors to the second line support engineer with the event logs.',
    ],
  },
  security: {
    title: 'Information Security Policy',
    sentences: [
      'All employees must use multi-factor authentication when accessing corporate systems remotely.',
      'Passwords must be at least fourteen characters long and must never be shared or reused.',
      'Report suspected phishing emails to the security operations center using the report button.',
      'Laptops must have full disk encryption enabled and receive security patches within fourteen days.',
      'Access rights are granted on a least privilege basis and reviewed by managers every quarter.',
      'Sensitive data must be classified and stored only in approved, encrypted repositories.',
      'Security incidents must be reported within one hour of detection to the incident response team.',
      'Third-party vendors must sign a data processing agreement before receiving personal data.',
      'Removable media is blocked by default and requires an exception approved by the security officer.',
      'Firewall rules are reviewed twice a year and unused rules are removed.',
      'Privileged accounts are monitored and sessions are recorded for audit purposes.',
      'Backups are tested monthly to verify that critical systems can be restored.',
    ],
  },
  onboarding: {
    title: 'Employee Onboarding Guide',
    sentences: [
      'Welcome to the team; your manager will schedule an introduction meeting during your first week.',
      'New employees receive their laptop and badge from the facilities desk on the first day.',
      'Complete the mandatory compliance training modules within thirty days of your start date.',
      'Your buddy will help you find your way around the campus and answer practical questions.',
      'Register your working hours and leave requests in the human resources portal.',
      'The pension plan and health insurance enrollment must be completed in the first month.',
      'Set personal development goals together with your manager during the onboarding review.',
      'Lunch is served in the restaurant on the ground floor between noon and two.',
      'The employee handbook explains the code of conduct and the expense reimbursement process.',
      'Travel requests are submitted through the travel portal and approved by your manager.',
      'Join the welcome session for new hires that takes place on the first Monday of each month.',
      'Probation evaluations take place after three months with feedback from your team.',
    ],
  },
};

export function paragraphs(topic: string, seed: number, count: number): string[] {
  const rand = seededRandom(seed);
  const pool = TOPICS[topic].sentences;
  return Array.from({ length: count }, () =>
    Array.from({ length: 4 }, () => pool[Math.floor(rand() * pool.length)]).join(' '),
  );
}

function wrap(text: string, width = 95): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if ((line + ' ' + word).trim().length > width) {
      lines.push(line);
      line = word;
    } else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line);
  return lines;
}

export async function makePdf(title: string, paras: string[], docCode: string, pages = 3): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const perPage = Math.ceil(paras.length / pages);
  for (let p = 0; p < pages; p++) {
    const page = pdf.addPage([595, 842]);
    page.drawText('ACME Holdings N.V. - Confidential', { x: 50, y: 800, size: 9, font });
    page.drawText(docCode, { x: 450, y: 800, size: 9, font });
    let y = 760;
    if (p === 0) {
      page.drawText(title, { x: 50, y, size: 16, font: bold });
      y -= 30;
    }
    for (const para of paras.slice(p * perPage, (p + 1) * perPage)) {
      for (const line of wrap(para)) {
        page.drawText(line, { x: 50, y, size: 10, font });
        y -= 14;
      }
      y -= 8;
    }
    page.drawText('Printed copies are uncontrolled', { x: 50, y: 30, size: 8, font });
    page.drawText(`Page ${p + 1} of ${pages}`, { x: 270, y: 30, size: 9, font });
  }
  return pdf.save();
}

export async function makeDocx(title: string, paras: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [
      {
        headers: { default: new Header({ children: [new Paragraph('ACME Holdings N.V. - Internal')] }) },
        footers: { default: new Footer({ children: [new Paragraph('Printed copies are uncontrolled')] }) },
        children: [
          new Paragraph({ children: [new TextRun({ text: title, bold: true, size: 32 })] }),
          ...paras.map((p) => new Paragraph(p)),
        ],
      },
    ],
  });
  return Packer.toBuffer(doc);
}

async function main(): Promise<void> {
  const out = path.resolve(process.argv[2] ?? '../sample-data');
  await mkdir(out, { recursive: true });
  let seed = 1;
  for (const [key, topic] of Object.entries(TOPICS)) {
    for (let i = 1; i <= 4; i++) {
      const paras = paragraphs(key, seed++, 9);
      const title = `${topic.title} ${i}`;
      const code = `DOC-${key.slice(0, 3).toUpperCase()}-${100 + i}`;
      if (i === 4) {
        await writeFile(path.join(out, `${key}-${i}.docx`), await makeDocx(title, paras));
      } else if (i === 3) {
        await writeFile(path.join(out, `${key}-${i}.txt`), `${title}\n\n${paras.join('\n\n')}\n`);
      } else {
        await writeFile(path.join(out, `${key}-${i}.pdf`), await makePdf(title, paras, code));
      }
    }
  }
  console.log(`sample documents written to ${out}`);
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  await main();
}
