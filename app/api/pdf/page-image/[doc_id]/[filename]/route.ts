const BACKEND = process.env.BACKEND_URL || 'http://127.0.0.1:8000';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ doc_id: string; filename: string }> }
) {
  try {
    const { doc_id, filename } = await params;
    const res = await fetch(`${BACKEND}/pdf/page-image/${doc_id}/${filename}`);
    
    if (!res.ok) {
      return new Response(await res.text(), { status: res.status });
    }
    
    return new Response(res.body, {
      status: res.status,
      headers: {
        'Content-Type': res.headers.get('Content-Type') || 'image/png',
      },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({ detail: error.message || 'Page image proxy failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
