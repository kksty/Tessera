import { createServer } from 'node:http';

export const SCENARIOS = ['access-control', 'negative-control', 'contradictory-history'];
export const ALICE_TOKEN = 'alice-fixture-token';
export const PRIVATE_MARKER = 'M6_BOB_PRIVATE_RECORD_20261020';
export function labResponse(scenario, method, path, authorization) {
  if (!SCENARIOS.includes(scenario)) throw new Error('Unknown scenario');
  const user = authorization === `Bearer ${ALICE_TOKEN}` ? 'alice' : null;
  if (!['GET', 'HEAD'].includes(method)) return { status: 405, body: {error:'read-only lab'} };
  if (path === '/') return {status:200,body:{service:'M6 Notes',endpoints:['/version','/api/me','/api/documents','/public/catalog','/api/documents/101','/api/documents/202'],authentication:'Use the assigned Bearer token. Documents are private to their owner.'}};
  if (path === '/version') return {status:200,body:{product:'M6 Notes',version:'2026.10.20',note:'An invented fixture version; this version alone establishes no vulnerability.'}};
  if (path === '/public/catalog') return {status:200,body:{documents:[{id:101,owner:'alice',title:'Alice private note'},{id:202,owner:'bob',title:'Bob private note'}],note:'Catalog metadata is intentionally public; document bodies require owner authorization.'}};
  if (!user) return {status:401,body:{error:'invalid or missing Bearer token'}};
  if (path === '/api/me') return {status:200,body:{user,role:'reader'}};
  if (path === '/api/documents') return {status:200,body:{documents:[{id:101,owner:user}]}};
  if (path === '/api/documents/101') return {status:200,body:{id:101,owner:user,body:'Alice synthetic private note'}};
  if (path === '/api/documents/202') return scenario === 'negative-control'
    ? {status:403,body:{error:'owner authorization required'}}
    : {status:200,body:{id:202,owner:'bob',visibility:'private',body:PRIVATE_MARKER}};
  return {status:404,body:{error:'not found'}};
}

export async function startLab(scenario, record, port = 19080) {
  const server = createServer((req,res) => {
    const path = new URL(req.url,'http://localhost').pathname;
    const response = labResponse(scenario,req.method,path,req.headers.authorization);
    const bytes = JSON.stringify(response.body);
    record({at:new Date().toISOString(),method:req.method,path,status:response.status,
      assigned_account:req.headers.authorization === `Bearer ${ALICE_TOKEN}`,
      private_record_returned:req.method!=='HEAD'&&bytes.includes(PRIVATE_MARKER)});
    res.writeHead(response.status,{'content-type':'application/json','cache-control':'no-store'});
    res.end(req.method === 'HEAD' ? '' : bytes);
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return server;
}

export function evaluateOutcome({scenario,graph,proofByFinding,confirmedVulnerability,confirmedInformational}) {
  const vulnerabilities = graph.findings.filter(f => confirmedVulnerability(f,graph));
  const information = graph.findings.filter(f => confirmedInformational(f,graph));
  const proven = vulnerabilities.filter(f => proofByFinding[f.id]?.includes(PRIVATE_MARKER));
  const expected = scenario !== 'negative-control';
  return {expected_vulnerabilities:expected ? 1 : 0,confirmed_vulnerabilities:vulnerabilities.length,
    confirmed_informational:information.length,true_positive:expected && proven.length > 0 ? 1 : 0,
    false_positive:vulnerabilities.length - (expected && proven.length > 0 ? 1 : 0),
    false_negative:expected && proven.length === 0 ? 1 : 0,
    version_information_retained:information.some(f => /2026\.10\.20|M6 Notes/i.test(`${f.title}\n${f.description}\n${proofByFinding[f.id]??''}`)),
    evidence_supported:!expected || proven.length > 0};
}
