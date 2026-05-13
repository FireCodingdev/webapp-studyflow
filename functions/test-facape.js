const FIREBASE_WEB_API_KEY = 'AIzaSyC8IqRSiaaS6Vk6IHm-JQeK4MdMqPZVkP0';
const PROXY_URL = 'https://facapeproxy-xesxvi757a-uc.a.run.app';

async function main() {
  const { idToken } = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`,
    { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'daniboymatos2@gmail.com', password: 'Veronica1023@', returnSecureToken: true }) }
  ).then(r => r.json());

  const body = await fetch(PROXY_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${idToken}` },
    body: JSON.stringify({ matricula: '27805', senha: 'Dm1234' }),
  }).then(r => r.json());

  console.log('=== CALENDÁRIO ===');
  console.log(JSON.stringify(body.data?.calendario, null, 2));
}
main().catch(console.error);
