/** Demo only: anyone who posts here is signed in as "demo". A real app signs users in with its own auth. */
export function POST(request: Request): Response {
  // Back to the page that asked, from a fixed list: a redirect target read from a request must never leave the site.
  const back = new URL(request.url).searchParams.get("return") === "lab" ? "/lab" : "/";
  return new Response(null, {
    status: 303,
    headers: { location: back, "set-cookie": "demo-user=demo; Path=/; HttpOnly; SameSite=Lax" },
  });
}
