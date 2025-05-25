import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();

export const notifyCommunityChallengeAvailable = functions.https.onRequest(async (req, res) => {
  const log = functions.logger;
  log.info('Invocación de función', { body: req.body });

  if (req.method !== 'POST') {
    log.warn('Método inválido', { method: req.method });
    res.status(405).send('Method Not Allowed');
    return;
  }

  const { nombreComunidad, carreraUid, creadorUid } = req.body || {};
  if (!nombreComunidad || !carreraUid || !creadorUid) {
    log.error('Faltan parámetros', { nombreComunidad, carreraUid, creadorUid });
    res.status(400).json({ error: 'Missing or invalid parameters' });
    return;
  }

  const nombre = nombreComunidad.trim();
  log.info('Buscando comunidad por nombreGrupo', { nombre });

  try {
    // 1) Leo TODAS las comunidades
    const comunidadesSnap = await admin.database().ref('/comunidad').once('value');
    log.debug('Snapshot de /comunidad obtenido', { count: comunidadesSnap.numChildren() });

    let comunidadId: string = '';
    let comunidadData: any = null;

    comunidadesSnap.forEach(child => {
      const data = child.val();
      if (data.nombreGrupo === nombre) {
        comunidadId = child.key as string;
        comunidadData = data;
        return true;
      }
      return false;
    });

    if (!comunidadId) {
      log.warn('No se halló comunidad', { nombre });
      res.json({ success: 0, failure: 0, message: 'Community not found' });
      return;
    }
    log.info('Comunidad encontrada', { comunidadId });

    // 2) Verifico participantes
    const participantesObj = comunidadData.participantes;
    log.debug('Objeto participantes', { participantesObj });

    if (!participantesObj || typeof participantesObj !== 'object') {
      log.warn('No hay participantes en la comunidad', { comunidadId });
      res.json({ success: 0, failure: 0, message: 'No participants in community' });
      return;
    }

    // 3) Recojo tokens - CORRECCIÓN AQUÍ
    const messages: admin.messaging.Message[] = [];
    let skippedNoToken = 0;
    let skippedCreador = 0;

    // CAMBIO PRINCIPAL: Obtener los valores (UIDs de usuarios) en lugar de las claves
    const participantesArray: string[] = Array.isArray(participantesObj)
      ? participantesObj  // Si es array, usar tal como está
      : Object.values(participantesObj);  // Si es objeto, usar los VALORES no las claves

    log.debug('UIDs de participantes extraídos', { participantesArray });

    for (const participanteUid of participantesArray) {
      if (participanteUid === creadorUid) {
        log.debug('Saltando creador de la carrera', { participanteUid });
        skippedCreador++;
        continue;
      }

      log.debug('Procesando participante', { participanteUid });
      const tokenSnap = await admin.database()
        .ref(`/usuarios/${participanteUid}/fcmToken`)
        .once('value');
      const token = tokenSnap.val();
      log.debug('Token obtenido', { participanteUid, tokenExists: !!token });

      if (!token) {
        skippedNoToken++;
        continue;
      }

      messages.push({
        token,
        notification: {
          title: 'Nueva carrera disponible',
          body: `Hay una carrera en tu comunidad "${nombre}". ¡Únete!`
        },
        data: {
          // Añadimos el tipo de notificación
          type: "community_challenge",
          // Aseguramos que los valores sean strings
          carreraUid: carreraUid.toString(),
          comunidadId: comunidadId.toString(),
          comunidadNombre: nombre,
          // Duplicamos la información en campos para el cliente
          title: 'Nueva carrera disponible',
          body: `Hay una carrera en tu comunidad "${nombre}". ¡Únete!`
        }
      });
    }

    log.info('Resumen tokens', {
      totalParticipants: participantesArray.length,
      skippedCreador,
      skippedNoToken,
      messagesPrepared: messages.length
    });

    if (messages.length === 0) {
      res.json({ success: 0, failure: 0, message: 'No eligible users to notify' });
      return;
    }

    // 4) Envío FCM
    const results = await Promise.all(messages.map(msg =>
      admin.messaging().send(msg)
        .then(() => 'success')
        .catch(err => {
          log.error('Error enviando mensaje', { error: err });
          return 'failure';
        })
    ));

    const successCount = results.filter(r => r === 'success').length;
    const failureCount = results.filter(r => r === 'failure').length;
    log.info('Resultados final', { successCount, failureCount });

    res.json({ success: successCount, failure: failureCount });
  } catch (err: any) {
    log.error('Error general en la función', { error: err });
    res.status(500).json({ error: 'Internal Server Error', message: err.message });
  }
});