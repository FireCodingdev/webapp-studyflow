# Firebase App Check — Setup & Migração

## Passo 1 — Ativar App Check no Firebase Console

1. Acesse [Firebase Console](https://console.firebase.google.com) → projeto `aplicativo-studyflow-4f501`
2. No menu lateral: **Build → App Check**
3. Clique em **Começar** (se for a primeira vez)

---

## Passo 2 — Registrar o app web com reCAPTCHA v3

1. Em App Check, clique na aba **Apps**
2. Selecione o app web (`1:92968084905:web:f5a96cb595f1bd2f9750b8`)
3. Escolha o provider: **reCAPTCHA v3**
4. O console abre o [Google reCAPTCHA Admin](https://www.google.com/recaptcha/admin)
   - Tipo: **reCAPTCHA v3**
   - Domínios: adicione `localhost` (dev) e o domínio de produção
   - Copie a **Site key** gerada
5. Cole a site key de volta no Firebase Console e confirme

---

## Passo 3 — Substituir a site key em `firebase.js`

No arquivo `firebase.js`, localize a linha:

```js
provider: new ReCaptchaV3Provider('6LfaU-wsAAAAAFK9CM50OV0r04yMZBLmtpPwJHKn'),
```

Substitua pela site key obtida no Passo 2 caso ela mude, ou confirme que a atual já é a correta.

> A Secret key do reCAPTCHA **nunca vai para o cliente** — apenas a Site key é usada aqui.

---

## Passo 4 — Deploy das Cloud Functions

```bash
firebase deploy --only functions
```

As funções `geminiProxy` e `classroomToken` já estão no **modo monitor**:
- Token ausente → requisição permitida + log de aviso no Cloud Logging
- Token presente mas inválido → bloqueado com HTTP 401

Para ativar o **modo enforce** (bloquear 100% sem token), edite `functions/index.js` em `validateAppCheck`:
```js
// Remova este bloco (modo monitor):
if (!token) {
  console.warn('[AppCheck] Token ausente — requisição permitida (modo monitor)');
  return true;
}
// Substitua por:
if (!token) {
  res.status(401).json({ error: 'App Check inválido' });
  return false;
}
```

---

## Passo 5 — Checklist de migração para Android (PlayIntegrityProvider)

Quando o app for empacotado como TWA ou app nativo Android:

- [ ] No `firebase.js`, troque o import e o provider:
  ```js
  // Antes (web):
  import { ReCaptchaV3Provider } from 'firebase/app-check';
  provider: new ReCaptchaV3Provider('SITE_KEY')

  // Depois (Android nativo via Firebase JS SDK no WebView, ou React Native):
  import { PlayIntegrityProvider } from 'firebase/app-check';
  provider: new PlayIntegrityProvider('FIREBASE_APP_ID_ANDROID')
  ```
- [ ] Registrar o app Android no Firebase Console → App Check → Apps → selecionar **Play Integrity**
- [ ] `getAppCheckToken()`, todos os headers `X-Firebase-AppCheck` e a validação no servidor **não precisam de nenhuma alteração**
- [ ] Testar em device real (Play Integrity não funciona em emulador sem configuração extra)
- [ ] Ativar modo enforce nas funções após validar que 100% das sessões enviam token

---

## Referências

- [Firebase App Check docs](https://firebase.google.com/docs/app-check)
- [Play Integrity provider](https://firebase.google.com/docs/app-check/android/play-integrity-provider)
- [reCAPTCHA v3 provider](https://firebase.google.com/docs/app-check/web/recaptcha-provider)
