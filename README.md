# Infinity WhatsApp Bot — Studio Infinity CR

Chatbot de WhatsApp (Meta Cloud API) potenciado por Claude. Responde dudas de
clientes/leads sobre el Método Nexus, programas y precios, y cuando detecta un
lead real lo registra automáticamente en tu CRM (mismo Supabase del Nexus Engine,
aparece en la pestaña CRM como "Prospecto" o "Active").

## 1. Configurar Meta WhatsApp Cloud API

Ya tenés WhatsApp Business / Meta Business Manager configurado, así que:

1. Entrá a **developers.facebook.com** → tu App → **WhatsApp > API Setup**.
2. Anotá el **Phone Number ID** (lo vas a poner en `WHATSAPP_PHONE_NUMBER_ID`).
3. Generá un **token permanente**:
   - Meta Business Suite → **Configuración del negocio** → **Usuarios del sistema**
     (System Users) → crear uno (rol Admin) → **Generar token** → marcá los
     permisos `whatsapp_business_messaging` y `whatsapp_business_management` →
     sin expiración.
   - Ese token va en `WHATSAPP_TOKEN`.
4. Inventá un string cualquiera para `VERIFY_TOKEN` (ej: `infinity-secret-2026`),
   lo necesitás en el paso 4 de Render.

## 2. Crear cuenta gratis en Render

1. Entrá a **render.com**, creá cuenta (podés usar tu GitHub).
2. **New +** → **Web Service**.
3. Conectá el repo donde subas esta carpeta (podés crear un repo nuevo en
   GitHub, ej: `INFINTYSTUDIOCR/infinity-whatsapp-bot`, y subir estos archivos
   igual que hacés con el Nexus Engine — Add file → Upload files).
4. Configuración del servicio:
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
5. En **Environment** (variables de entorno), agregá todas las de `.env.example`
   con tus valores reales:
   - `ANTHROPIC_API_KEY`
   - `WHATSAPP_TOKEN`
   - `WHATSAPP_PHONE_NUMBER_ID`
   - `VERIFY_TOKEN`
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
6. **Create Web Service**. Esperá a que termine el deploy (unos minutos). Te va
   a dar una URL tipo `https://infinity-whatsapp-bot.onrender.com`.

> **Nota sobre el plan Free de Render**: el servicio "duerme" tras ~15 min sin
> tráfico y demora unos segundos en despertar con el primer mensaje. Para un
> bot de WhatsApp esto generalmente no se nota (Meta reintenta el webhook). Si
> más adelante el volumen crece, conviene pasar al plan pago ($7/mes) para que
> esté siempre activo.

## 3. Conectar el webhook en Meta

1. En **developers.facebook.com** → tu App → **WhatsApp > Configuration**.
2. **Webhook** → **Edit**:
   - **Callback URL**: `https://TU-APP.onrender.com/webhook`
   - **Verify Token**: el mismo que pusiste en `VERIFY_TOKEN`
3. **Verify and save**.
4. En **Webhook fields**, suscribite a **messages**.

## 4. Probar

Escribile por WhatsApp al número de Studio Infinity desde tu celular personal.
El bot debería responder en segundos. Mirá los logs en Render (pestaña "Logs")
para ver el flujo `[IN]` / `[OUT]`.

## Cómo funciona la integración con el CRM

- Cada conversación se guarda en la tabla `infinity_sessions` con id
  `CHAT-<numero>`, así el bot recuerda el contexto aunque Render se reinicie.
- Cuando Claude detecta un lead real (nombre + programa de interés), usa la
  herramienta `create_lead`, que crea un registro en `infinity_students` con
  `isLead: true` — aparece automáticamente en **CRM · Leads** del Nexus Engine,
  clasificado en Active / Prospecto / Needs Plan según la conversación.
- También queda un registro en el **Log de auditoría** del Engine
  (`Creó lead desde WhatsApp`).

## Personalizar las respuestas

Todo el conocimiento del bot está en la constante `SYSTEM_PROMPT` dentro de
`server.js` — ahí podés ajustar precios, descripciones de programas, tono,
preguntas frecuentes, etc. Después de editar, hacé commit y Render redeploya
automáticamente.

## Límites conocidos / próximos pasos posibles

- Solo procesa mensajes de **texto**. Audios/imágenes se ignoran (se puede
  agregar transcripción con Claude si hace falta).
- `create_lead` se ejecuta como máximo una vez por número de teléfono.
- No envía mensajes salientes proactivos (recordatorios) — esto es solo
  respuesta a mensajes entrantes. Los recordatorios automáticos (pagos,
  sesiones) serían un proyecto aparte usando WhatsApp Message Templates.
