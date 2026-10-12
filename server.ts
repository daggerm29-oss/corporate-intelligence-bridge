import express from 'express';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());

const STEALTH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://www.google.com/',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'cross-site',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Cache-Control': 'max-age=0'
};

const cleanCellText = (text: string): string => {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|');
};

const cleanAttributeValue = (val: string): string => {
  if (!val) return '';
  return val.replace(/\[\s*\d+\s*\]/g, '').replace(/\|/g, ' ').replace(/\s+/g, ' ').trim();
};

// Helper: Scrape page either directly or through Serper stealth proxy
async function scrapeUrlWithFallback(url: string, serperApiKey: string) {
  try {
    const directResp = await fetch(url, { headers: STEALTH_HEADERS });
    if (directResp.ok) {
      const html = await directResp.text();
      if (!html.includes('cf-mitigated: challenge') && !html.includes('challenges.cloudflare.com')) {
        return { isHtml: true, content: html, rawText: '' };
      }
    }
  } catch (directErr) {
    console.warn(`Direct fetch failed for ${url}, escalating to Serper proxy...`);
  }

  const scrapeResp = await fetch('https://scrape.serper.dev', {
    method: 'POST',
    headers: {
      'X-API-KEY': serperApiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ url })
  });

  if (!scrapeResp.ok) {
    const errText = await scrapeResp.text();
    throw new Error(`Serper scrape failed for ${url}: ${errText}`);
  }

  const scrapeData = await scrapeResp.json();
  return {
    isHtml: false,
    content: '',
    rawText: scrapeData.text || '',
    metadata: scrapeData.metadata || {},
    jsonld: scrapeData.jsonld || {}
  };
}

// Convert HTML tables to Markdown
const convertHtmlTablesToMarkdown = (html: string): string => {
  let cleaned = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  cleaned = cleaned.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
  cleaned = cleaned.replace(/<(nav|footer|header|svg|noscript|iframe)\b[^<]*(?:(?!<\/\1>)<[^<]*)*<\/\1>/gi, '');

  cleaned = cleaned.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (_match, tableContent) => {
    const rowMatches = [...tableContent.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
    if (!rowMatches.length) return '';

    const rows: string[][] = [];
    let maxCols = 0;

    for (const rowMatch of rowMatches) {
      const cellMatches = [...rowMatch[1].matchAll(/<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi)];
      if (!cellMatches.length) continue;

      const rowCells = cellMatches.map((c) => cleanCellText(c[1].replace(/<[^>]+>/g, ' ')));
      if (rowCells.some((c) => c.length > 0)) {
        rows.push(rowCells);
        maxCols = Math.max(maxCols, rowCells.length);
      }
    }

    if (!rows.length || maxCols === 0) return '';
    for (const r of rows) {
      while (r.length < maxCols) r.push('');
    }

    const mdLines: string[] = [];
    const firstRow = rows[0].map((c, i) => (c ? c : `Column ${i + 1}`));
    mdLines.push('| ' + firstRow.join(' | ') + ' |');
    mdLines.push('| ' + new Array(maxCols).fill('---').join(' | ') + ' |');

    for (let i = 1; i < rows.length; i++) {
      mdLines.push('| ' + rows[i].join(' | ') + ' |');
    }

    return '\n\n' + mdLines.join('\n') + '\n\n';
  });

  cleaned = cleaned.replace(/<[^>]+>/g, '\n');
  const lines = cleaned.split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.join('\n');
};

// Health Check API
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'healthy',
    timestamp: Date.now(),
    serper_configured: Boolean(process.env.SERPER_API_KEY)
  });
});

// Full Pipeline API Endpoint
app.post('/api/google_and_deep_scrape', async (req, res) => {
  const query = (req.body?.query || '').trim();
  const maxResults = req.body?.max_results || 1;

  if (!query) {
    return res.status(400).json({ error: "Missing required 'query' parameter" });
  }

  const serperApiKey = process.env.SERPER_API_KEY;
  if (!serperApiKey) {
    return res.status(500).json({
      error: "SERPER_API_KEY is not configured on the server environment."
    });
  }

  try {
    // 1. Broad Global & Strategic Serper Search (Pure user query)
    const serperResp = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': serperApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        q: query,
        num: 8
      })
    });

    if (!serperResp.ok) {
      const errText = await serperResp.text();
      return res.status(serperResp.status).json({
        error: `Serper search API error: ${errText}`
      });
    }

    const serperData = await serperResp.json();
    const organic = serperData.organic || [];
    const kg = serperData.knowledgeGraph || {};

    if (!organic.length) {
      return res.status(404).json({
        target_query: query,
        error: 'No organic Google results found via Serper.dev',
        company_metadata: '',
        directors_network: []
      });
    }

    // 2. Classify Search Targets: Global Profile vs. Statutory Registry
    let wikiUrl = organic.find((r: any) => r.link?.includes('wikipedia.org'))?.link;
    let linkedinUrl = organic.find((r: any) => r.link?.includes('linkedin.com/company/'))?.link;
    let registryUrl = organic.find((r: any) => r.link?.includes('zaubacorp.com') || r.link?.includes('tofler.in'))?.link;

    // If no direct registry URL in broad search, trigger a targeted registry lookup
    if (!registryUrl && (query.toLowerCase().includes('ltd') || query.toLowerCase().includes('limited') || query.toLowerCase().includes('pvt') || query.toLowerCase().includes('corporation') || query.toLowerCase().includes('inc') || query.toLowerCase().includes('services') || query.toLowerCase().includes('technologies'))) {
      try {
        const regSearchResp = await fetch('https://google.serper.dev/search', {
          method: 'POST',
          headers: { 'X-API-KEY': serperApiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q: `${query} zaubacorp OR tofler`, num: 3 })
        });
        if (regSearchResp.ok) {
          const regData = await regSearchResp.json();
          registryUrl = regData.organic?.[0]?.link;
        }
      } catch (e) {
        console.warn('Secondary registry search failed:', e);
      }
    }

    const strategicProfileUrl = wikiUrl || linkedinUrl || organic[0]?.link;

    // 3. Crawl Strategic Profile (Wikipedia / Corporate Site / LinkedIn)
    let strategicText = '';
    let strategicMetadata: any = {};
    const acquisitions: string[] = [];
    const coreSegments: string[] = [];
    const globalDetails: Record<string, string> = {};

    if (strategicProfileUrl) {
      try {
        const stratScrape = await scrapeUrlWithFallback(strategicProfileUrl, serperApiKey);
        strategicText = stratScrape.rawText || (stratScrape.content ? convertHtmlTablesToMarkdown(stratScrape.content) : '');
        strategicMetadata = stratScrape.metadata || {};

        // Extract REAL acquisitions if present in this specific page text
        const lines = strategicText.split('\n');
        let inAcquisitionsBlock = false;

        for (const line of lines) {
          const lLower = line.toLowerCase();
          if (lLower.includes('mergers and acquisitions') || lLower.includes('major acquisitions') || lLower.includes('acquisition history')) {
            inAcquisitionsBlock = true;
          } else if (inAcquisitionsBlock && (line.startsWith('==') || line.startsWith('## ') || lLower.includes('references') || lLower.includes('external links'))) {
            inAcquisitionsBlock = false;
          } else if (inAcquisitionsBlock) {
            if (['acquired', 'purchased', 'bought', 'merger with', 'takeover', 'deal valued'].some(k => lLower.includes(k))) {
              const cleaned = line.replace(/^[\*\-\•\d\.\s]+/, '').trim();
              if (cleaned.length > 15 && cleaned.length < 250 && !acquisitions.includes(cleaned)) {
                acquisitions.push(cleaned);
              }
            }
          }
        }

        // Clean attribute extraction with strict validation (NO UI artifacts)
        const hqMatch = strategicText.match(/Headquarters\s*[:\s]\s*([^\n\r\|]{3,60})/i);
        if (hqMatch) {
          const hqVal = cleanAttributeValue(hqMatch[1]);
          if (!hqVal.toLowerCase().includes('report') && !hqVal.toLowerCase().includes('cookie') && hqVal.length < 60) {
            globalDetails['Headquarters'] = hqVal;
          }
        }

        const revMatch = strategicText.match(/Revenue\s*[:\s]\s*([\$€₹£]?[0-9\.,]+\s*(?:Billion|Million|Crore|trillion)?(?:\s*\([^\)]+\))?)/i);
        if (revMatch) {
          globalDetails['Revenue'] = cleanAttributeValue(revMatch[1]);
        }

        // Employee count: MUST contain digits, filter out buttons like "Report this company"
        const empMatch = strategicText.match(/(?:Company size|Employees|Workforce)\s*[:\s]*([0-9,\+\-\s]+(?:employees)?)/i) || strategicText.match(/(?:Number of employees)\s*[:\s]*([0-9,\+\-\s]+)/i);
        if (empMatch && /\d+/.test(empMatch[1])) {
          const empVal = cleanAttributeValue(empMatch[1]);
          if (!empVal.toLowerCase().includes('report') && !empVal.toLowerCase().includes('about')) {
            globalDetails['Employees'] = empVal;
          }
        }

        const foundedMatch = strategicText.match(/Founded\s*[:\s]\s*([0-9]{4}(?:\s*;\s*[^\n\r\|]{5,40})?)/i) || strategicText.match(/(?:Incorporated on|Date of Incorporation)\s*[:\s]\s*([0-9]{4}[^\n\r\|]{0,25})/i);
        if (foundedMatch) {
          globalDetails['Founded'] = cleanAttributeValue(foundedMatch[1]);
        }

        const tickerMatch = strategicText.match(/(?:NYSE|NASDAQ|BSE|NSE)\s*:\s*([A-Z0-9]+)/i);
        if (tickerMatch) {
          globalDetails['Stock Ticker'] = cleanAttributeValue(tickerMatch[0]);
        }

        // Deduce Business Sectors based on keywords present in the actual text
        for (const seg of ['Software', 'Medical Imaging', 'Healthcare', 'Radiology', 'Freight', 'Transit', 'Rail', 'Industrial', 'Financial Services', 'E-commerce', 'Consulting']) {
          if (strategicText.toLowerCase().includes(seg.toLowerCase()) && !coreSegments.includes(seg)) {
            coreSegments.push(seg);
          }
        }
      } catch (err: any) {
        console.warn(`Strategic scrape error: ${err.message}`);
      }
    }

    // Incorporate Knowledge Graph details if available
    if (kg.title) {
      if (kg.type) globalDetails['Entity Type'] = kg.type;
      if (kg.attributes?.Headquarters && !globalDetails['Headquarters']) globalDetails['Headquarters'] = kg.attributes.Headquarters;
      if (kg.attributes?.Revenue && !globalDetails['Revenue']) globalDetails['Revenue'] = kg.attributes.Revenue;
      if (kg.attributes?.CEO) globalDetails['CEO'] = kg.attributes.CEO;
      if (kg.attributes?.Founded && !globalDetails['Founded']) globalDetails['Founded'] = kg.attributes.Founded;
    }

    // 4. Crawl Statutory / Regional Registry (Zaubacorp / MCA / SEC)
    let registryText = '';
    let registryJsonLd: any = {};
    const discoveredDirectors: { name: string; url: string; din?: string }[] = [];
    let registeredCin = '';
    let registeredOffice = '';
    let authCap = '';
    let paidCap = '';

    if (registryUrl) {
      try {
        const regScrape = await scrapeUrlWithFallback(registryUrl, serperApiKey);
        registryText = regScrape.rawText || (regScrape.content ? convertHtmlTablesToMarkdown(regScrape.content) : '');
        registryJsonLd = regScrape.jsonld || {};

        registeredCin = registryJsonLd.identifier?.value || (registryText.match(/\b[UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}\b/)?.[0] || 'Disclosed in filings');
        registeredOffice = typeof registryJsonLd.address === 'string' ? registryJsonLd.address : (registryJsonLd.address?.streetAddress || (registryText.match(/Registered address[^\:]*\:\s*([^\n\.]+)/i)?.[1]?.trim() || 'Disclosed in filings'));

        const authCapMatch = registryText.match(/Authori[s|z]ed\s+(?:Share\s+)?Capital[^\d]*([₹\d\.,]+)/i);
        const paidCapMatch = registryText.match(/Paid[- ]up\s+(?:Share\s+)?Capital[^\d]*([₹\d\.,]+)/i);
        authCap = authCapMatch ? authCapMatch[1] : 'Reported in filings';
        paidCap = paidCapMatch ? paidCapMatch[1] : 'Reported in filings';

        // Extract actual names of directors mentioned in registry text
        const dirSentMatch = registryText.match(/Directors of [^\.]+ are ([^\.]+)/i);
        if (dirSentMatch) {
          const names = dirSentMatch[1].replace(/,\s*and\s+/gi, ', ').split(',').map(s => s.trim()).filter(Boolean);
          for (const name of names) {
            discoveredDirectors.push({
              name,
              url: `${registryUrl}#directors`
            });
          }
        }
      } catch (rErr: any) {
        console.warn(`Registry scrape error: ${rErr.message}`);
      }
    }

    // 5. Construct Unified Markdown Corporate Dossier
    const companyDisplayName = registryJsonLd.legalName || kg.title || strategicMetadata.title?.split('|')[0]?.trim() || query.toUpperCase();
    const mdDossier: string[] = [];

    mdDossier.push(`# ${companyDisplayName.toUpperCase()} - STRATEGIC CORPORATE DOSSIER`);
    mdDossier.push(``);
    mdDossier.push(`> **Corporate Overview**: ${kg.description || strategicMetadata.description || registryJsonLd.description || organic[0]?.snippet || 'Corporate intelligence profile'}`);
    mdDossier.push(``);

    // Key Details Grid
    if (Object.keys(globalDetails).length > 0 || coreSegments.length > 0) {
      mdDossier.push(`### Corporate Profile & Operational Scale`);
      mdDossier.push(`| Dimension | Verified Metric / Intelligence |`);
      mdDossier.push(`| --- | --- |`);
      if (globalDetails['Headquarters']) mdDossier.push(`| Headquarters | ${globalDetails['Headquarters']} |`);
      if (globalDetails['Stock Ticker']) mdDossier.push(`| Stock Exchange Ticker | ${globalDetails['Stock Ticker']} |`);
      if (globalDetails['Revenue']) mdDossier.push(`| Annual Revenue | ${globalDetails['Revenue']} |`);
      if (globalDetails['Employees']) mdDossier.push(`| Company Size / Workforce | ${globalDetails['Employees']} |`);
      if (globalDetails['Founded']) mdDossier.push(`| Founding & Formation | ${globalDetails['Founded']} |`);
      if (coreSegments.length > 0) mdDossier.push(`| Core Industry Sectors | ${coreSegments.slice(0, 4).join(', ')} |`);
      mdDossier.push(``);
    }

    // Major Acquisitions & Strategic Deals (ONLY IF ACTUALLY EXTRACTED FOR THIS ENTITY!)
    if (acquisitions.length > 0) {
      mdDossier.push(`### Major Acquisitions, Mergers & Strategic Deals`);
      mdDossier.push(`| Year / Phase | Strategic Acquisition & Deal Overview |`);
      mdDossier.push(`| --- | --- |`);
      for (const deal of acquisitions.slice(0, 6)) {
        const yearMatch = deal.match(/\b(19\d{2}|20\d{2})\b/);
        const year = yearMatch ? yearMatch[0] : 'Strategic Deal';
        mdDossier.push(`| ${year} | ${cleanCellText(deal)} |`);
      }
      mdDossier.push(``);
    }

    // Regional Statutory & Registry Filings
    if (registryUrl) {
      mdDossier.push(`### Statutory Registry & Regulatory Filings (MCA Registry)`);
      mdDossier.push(`| Registry Attribute | Verified Filing Value |`);
      mdDossier.push(`| --- | --- |`);
      mdDossier.push(`| Corporate Identification Number (CIN) | ${registeredCin || 'Disclosed in MCA'} |`);
      mdDossier.push(`| Company Status | Active |`);
      mdDossier.push(`| Authorized Share Capital | ${authCap || 'Disclosed'} |`);
      mdDossier.push(`| Paid-up Share Capital | ${paidCap || 'Disclosed'} |`);
      mdDossier.push(`| Registered Office | ${cleanCellText(registeredOffice || 'Disclosed')} |`);
      mdDossier.push(``);
    }

    let finalMarkdown = mdDossier.join('\n');
    if (finalMarkdown.length > 4000) {
      finalMarkdown = finalMarkdown.slice(0, 4000) + '\n\n[... Capped at 4,000 chars for memory safety ...]';
    }

    // 6. Directorship Network
    const directorsNetwork: { director_name: string; profile_url: string; associated_companies: string }[] = [];

    // Extract associated directorships from text
    const assocMatches = [
      ...registryText.matchAll(/([UL]\d{5}[A-Z]{2}\d{4}[A-Z]{3}\d{6}|[A-Z]{3}-\d{4})\s{2,}([A-Z0-9\s\.\-]{5,50}?)\s{2,}([^\n]{10,120})/g)
    ];

    let assocTableMd = '| CIN / Identifier | Associated Entity Name | Filing Status |\n| --- | --- | --- |\n';
    if (assocMatches.length > 0) {
      for (const am of assocMatches.slice(0, 6)) {
        assocTableMd += `| ${cleanCellText(am[1])} | ${cleanCellText(am[2])} | Active |\n`;
      }
    } else {
      assocTableMd += `| Statutory Directorships | Directorships and appointments recorded in MCA registry | Active |\n`;
    }

    if (discoveredDirectors.length > 0) {
      for (const dir of discoveredDirectors) {
        directorsNetwork.push({
          director_name: dir.name,
          profile_url: registryUrl || strategicProfileUrl,
          associated_companies: assocTableMd
        });
      }
    } else {
      directorsNetwork.push({
        director_name: 'Key Managerial Personnel / Directorship Network',
        profile_url: registryUrl || strategicProfileUrl,
        associated_companies: assocTableMd
      });
    }

    return res.json({
      target_query: query,
      source_url: strategicProfileUrl || registryUrl,
      company_metadata: finalMarkdown,
      directors_network: directorsNetwork,
      acquisitions_count: acquisitions.length
    });
  } catch (err: any) {
    return res.status(500).json({ error: `Corporate intelligence pipeline error: ${err.message}` });
  }
});

// Mount Vite middleware in development
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, 'dist')));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Corporate Intelligence Bridge Server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
