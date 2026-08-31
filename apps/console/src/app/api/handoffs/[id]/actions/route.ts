import { NextResponse } from 'next/server';
import { apiPost } from '@/lib/api';

/**
 * Proxies a reviewer action to the API.
 *
 * The browser never talks to the API directly: the session credential stays on
 * the server, and the RFC 7807 problem document is passed through unchanged so
 * the reviewer reads the refusal the API actually wrote.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const body = (await request.json()) as Record<string, unknown>;

  const result = await apiPost<Record<string, unknown>>(`/v1/handoffs/${id}/actions`, body);

  if (!result.ok && result.problem) {
    return NextResponse.json(result.problem, { status: result.problem.status });
  }

  return NextResponse.json(result.data ?? {}, { status: 201 });
}
