import { JwksDiagnosticError, publicJwks } from '../_shared/jai-connect-read-signing.ts';

declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (request: Request) => Response | Promise<Response>): void;
};

// Public verification material only. Deploy with --no-verify-jwt.
Deno.serve(async request => {
  if (request.method !== 'GET') return new Response(null, { status: 405, headers: { Allow: 'GET' } });
  try {
    const keys = await publicJwks(Deno.env.get('JAI_CONNECT_SIGNING_KEYS'));
    return Response.json(keys, { headers: {
      'Cache-Control': 'public, max-age=60', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    // Fixed codes only: never log the error object or any key material.
    console.error('jai-connect-jwks:', error instanceof JwksDiagnosticError ? error.code : 'unexpected_error');
    return Response.json({ error: 'Verification keys unavailable' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
});
