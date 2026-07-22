const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ doc_id: string }> }
) {
  try {
    const { doc_id } = await params;
    const res = await fetch(`${BACKEND}/pdf/file/${doc_id}`);
    
    if (!res.ok) {
      return new Response(await res.text(), { status: res.status });
    }
    
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ detail: error.message || 'File serving proxy failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
