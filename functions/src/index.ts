import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

// Inicialización estándar
admin.initializeApp();

/**
 * HTTP Function que recibe un POST con JSON { name: string }
 * Lee todos los usuarios en /usuarios, envía una notificación a todos
 * los que tengan fcmToken excepto al propio disponible, enviando mensajes individualmente.
 * Responde con JSON { success: number, failure: number }.
 */
export const notifyAvailablePlayerIndividual = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  if (!req.body || typeof req.body !== 'object' || typeof req.body.name !== 'string' || req.body.name.trim() === '') {
     console.error('Solicitud inválida: falta o es inválido el campo "name" en el cuerpo.');
     res.status(400).json({ error: 'Missing or invalid "name" in request body. Ensure Content-Type is application/json.' });
     return;
  }

  const playerName = req.body.name.trim(); // Usar trim() para limpiar espacios
  console.log(`notifyAvailablePlayerIndividual invoked for: ${playerName}`);

  try {
    const usersSnap = await admin.database().ref('/usuarios').once('value');
    const users = usersSnap.val() as Record<string, { nombre?: string; fcmToken?: string }>;
    if (!users) {
      console.log('No users found under /usuarios');
      res.json({ success: 0, failure: 0, message: 'No users found' });
      return;
    }

    const messagesToSend: admin.messaging.Message[] = [];
    let skippedSelf = 0;
    let skippedNoToken = 0;

    // Recorrer los usuarios
    for (const [userId, userObj] of Object.entries(users)) {
      const { nombre, fcmToken } = userObj || {};

      // Log para inspeccionar los datos del usuario leídos
      console.log(`Procesando usuario ID: ${userId}, Datos: ${JSON.stringify(userObj)}`);

      // Comparación por nombre (si pasas UID en el request body, úsalo)
      if (typeof nombre === 'string' && nombre.trim() === playerName) {
         console.log(`Saltando notificación para el usuario ${userId} (${nombre}) porque coincide con el nombre del jugador disponible.`);
         skippedSelf++;
         continue; // Saltar este usuario
      }

      if (!fcmToken) {
         console.log(`Saltando notificación para el usuario ${userId} porque no tiene token FCM registrado.`);
         skippedNoToken++;
         continue; // Saltar si no hay token
      }

      // Si llegamos aquí, el usuario tiene token y no es el jugador que se añadió
       // Crear el objeto message (aunque se envíen individualmente)
       messagesToSend.push({
           token: fcmToken,
           notification: {
             title: '¡Jugador Disponible!',
             body: `${playerName} está esperando para jugar.`,
           },
           data: {
             title: '¡Jugador Disponible!',
             body: `${playerName} está esperando para jugar.`,
           },
       });

      console.log(`Preparado mensaje individual para usuario ${userId}.`);
    }

    console.log(`Skipped self notifications: ${skippedSelf}. Skipped (no token): ${skippedNoToken}. Total messages prepared: ${messagesToSend.length}`);

    if (messagesToSend.length === 0) {
      console.log('No eligible tokens to send notifications after filtering.');
      res.json({ success: 0, failure: 0, message: 'No eligible users to notify' });
      return;
    }

    // *** ENVÍO INDIVIDUAL DE MENSAJES ***
    console.log(`Sending ${messagesToSend.length} notifications individually...`);
    const sendPromises: Promise<string>[] = []; // Array para guardar las promesas de cada envío

    for (const message of messagesToSend) {
        sendPromises.push(
            admin.messaging().send(message) // Llamada individual a send()
                .then((response) => {
                    const token = (message as { token?: string }).token;
                    if (token) {
                        console.log(`Successfully sent message to token ending in ...${token.substring(token.length - 5)}: ${response}`);
                    } else {
                        console.log(`Successfully sent message: ${response}`);
                    }
                    return 'success'; // Indicar éxito
                })
                .catch((error) => {
                    const token = (message as { token?: string }).token;
                    if (token) {
                        console.error(`Failed to send message to token ending in ...${token.substring(token.length - 5)}:`, error);
                    } else {
                        console.error(`Failed to send message:`, error);
                    }
                    return 'failure'; // Indicar fallo
                })
        );
    }

    // Esperar a que todas las promesas de envío se completen
    const results = await Promise.all(sendPromises);

    const successCount = results.filter(r => r === 'success').length;
    const failureCount = results.filter(r => r === 'failure').length;

    console.log(`Resultados de envíos individuales: Éxito: ${successCount}, Fallo: ${failureCount}`);

    res.json({ success: successCount, failure: failureCount });

  } catch (error: any) {
    console.error('Error general en notifyAvailablePlayerIndividual:', error);
    res.status(500).json({
        error: 'Internal Server Error',
        message: error.message,
        // details: error // Descomentar con cuidado en desarrollo
    });
  }
});