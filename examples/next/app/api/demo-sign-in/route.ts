/** Demo only: anyone who posts here is signed in as "demo". A real app signs users in with its own auth. */
export function POST(): Response {
  return new Response(null, {
    status: 303,
    headers: { location: "/", "set-cookie": "demo-user=demo; Path=/; HttpOnly; SameSite=Lax" },
  });
}
