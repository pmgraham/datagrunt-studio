const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ doc_id: string }> }
) {
  try {
    const { doc_id } = await params;
    const body = await request.text();
    const res = await fetch(`${BACKEND}/pdf/rationalize/${doc_id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    return new Response(await res.text(), {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ detail: error.message || 'Rationalize proxy failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
