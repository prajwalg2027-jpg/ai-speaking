// Google Cloud calls made with the server's own service account (Cloud Run's metadata server gives the
// token; nothing is stored). Used for voice recordings in Cloud Storage, deleting a Firebase login, and Google Play.
const META = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';
const tokens = new Map(); // scopes ('' = the default) → { value, until }

/** An access token for the server's own service account; [scopes] for APIs outside Cloud's default scope (Google Play's). */
export async function accessToken(scopes = '') {
  const t = tokens.get(scopes);
  if (t && Date.now() < t.until) return t.value;
  const res = await fetch(scopes ? `${META}?scopes=${encodeURIComponent(scopes)}` : META, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!res.ok) throw new Error(`metadata token: HTTP ${res.status}`);
  const j = await res.json();
  tokens.set(scopes, { value: j.access_token, until: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

const enc = encodeURIComponent;

export async function gcsUpload(bucket, path, body, contentType) {
  const res = await fetch(`https://storage.googleapis.com/upload/storage/v1/b/${enc(bucket)}/o?uploadType=media&name=${enc(path)}`, {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': contentType }, body,
  });
  if (!res.ok) throw new Error(`Cloud Storage upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** An object's bytes, or null if it doesn't exist. */
export async function gcsDownload(bucket, path) {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${enc(bucket)}/o/${enc(path)}?alt=media`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloud Storage download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** An object as a stream: { body (a web ReadableStream), size }, or null if it doesn't exist. */
export async function gcsStream(bucket, path) {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${enc(bucket)}/o/${enc(path)}?alt=media`, {
    headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Cloud Storage download ${res.status}`);
  return { body: res.body, size: Number(res.headers.get('content-length')) || 0 };
}

export async function gcsDelete(bucket, path) {
  const res = await fetch(`https://storage.googleapis.com/storage/v1/b/${enc(bucket)}/o/${enc(path)}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${await accessToken()}` },
  });
  if (!res.ok && res.status !== 404) throw new Error(`Cloud Storage delete ${res.status}`);
}

/** Delete a Firebase login (needs the Firebase Authentication Admin role on the service account). */
export async function deleteFirebaseUser(project, uid) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects/${enc(project)}/accounts:delete`, {
    method: 'POST', headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ localId: uid }),
  });
  if (!res.ok) throw new Error(`Firebase account delete ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
