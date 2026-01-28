const jwt = require('jsonwebtoken');
const url = require('url');
const User = require('../model/User');
const Message = require('../model/Message');

// Store active connections: Map<WebSocket, {userId, user}>
const clients = new Map();

// Map userId -> Set<WebSocket> (for one-to-one chats)
const userSockets = new Map();

module.exports = (wss) => {
    // Helper function to send message to a WebSocket
    function sendToClient(ws, type, data) {
        if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify({ type, data }));
        }
    }

    // Helper to register a socket for a user
    function addUserSocket(userId, ws) {
        if (!userSockets.has(userId)) {
            userSockets.set(userId, new Set());
        }
        userSockets.get(userId).add(ws);
    }

    // Helper to unregister a socket for a user
    function removeUserSocket(userId, ws) {
        const set = userSockets.get(userId);
        if (!set) return;

        set.delete(ws);
        if (set.size === 0) {
            userSockets.delete(userId);
        }
    }

    // Helper to send an event to all sockets of a given user
    function sendToUser(userId, type, data, excludeWs = null) {
        const sockets = userSockets.get(userId);
        if (!sockets) return;

        sockets.forEach(socket => {
            if (socket !== excludeWs && socket.readyState === 1) {
                socket.send(JSON.stringify({ type, data }));
            }
        });
    }

    // Handle new WebSocket connection
    wss.on('connection', async (ws, req) => {
        console.log('New WebSocket connection attempt');

        // Extract token from query string or Authorization header
        const parsedUrl = url.parse(req.url, true);
        const token = parsedUrl.query.token || 
                     req.headers.authorization?.split(' ')[1] ||
                     req.headers['sec-websocket-protocol']?.split(',')[0]?.trim();

        if (!token) {
            sendToClient(ws, 'error', { message: 'Authentication error: Token required' });
            ws.close(1008, 'Token required');
            return;
        }

        try {
            // Verify JWT token
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const user = await User.findById(decoded.id).select('-password');

            if (!user) {
                sendToClient(ws, 'error', { message: 'Authentication error: User not found' });
                ws.close(1008, 'User not found');
                return;
            }

            // Store client information
            clients.set(ws, {
                userId: user._id.toString(),
                user: user
            });

            addUserSocket(user._id.toString(), ws);

            console.log(`User connected: ${user.username} (${user._id})`);

            // Send connection success message
            sendToClient(ws, 'connected', {
                message: 'Successfully connected',
                user: {
                    _id: user._id,
                    username: user.username,
                    email: user.email
                }
            });

        } catch (error) {
            console.error('Authentication error:', error);
            sendToClient(ws, 'error', { message: 'Authentication error: Invalid token' });
            ws.close(1008, 'Invalid token');
            return;
        }

        // Handle incoming messages
        ws.on('message', async (message) => {
            try {
                const client = clients.get(ws);
                if (!client) {
                    sendToClient(ws, 'error', { message: 'Client not authenticated' });
                    return;
                }

                const data = JSON.parse(message.toString());
                const { type, payload } = data;

                switch (type) {
                    case 'send_message':
                        const { content, receiverId } = payload || {};

                        // Validate input
                        if (!content || content.trim().length === 0) {
                            sendToClient(ws, 'error', { message: 'Message content cannot be empty' });
                            return;
                        }

                        if (!receiverId) {
                            sendToClient(ws, 'error', { message: 'Receiver ID is required for one-to-one chat' });
                            return;
                        }

                        if (receiverId === client.userId) {
                            sendToClient(ws, 'error', { message: 'You cannot send a message to yourself' });
                            return;
                        }

                        // Verify that receiver exists
                        const receiverUser = await User.findById(receiverId).select('_id username email');
                        if (!receiverUser) {
                            sendToClient(ws, 'error', { message: 'Receiver not found' });
                            return;
                        }

                        // Create message in database
                        const message = new Message({
                            sender: client.userId,
                            receiver: receiverId,
                            content: content.trim()
                        });

                        await message.save();

                        // Populate sender & receiver information
                        await message.populate('sender', 'username email');
                        await message.populate('receiver', 'username email');

                        // Prepare message data
                        const messageData = {
                            _id: message._id,
                            sender: {
                                _id: message.sender._id,
                                username: message.sender.username,
                                email: message.sender.email
                            },
                            receiver: {
                                _id: message.receiver._id,
                                username: message.receiver.username,
                                email: message.receiver.email
                            },
                            content: message.content,
                            createdAt: message.createdAt
                        };

                        // Send to sender (all their sockets)
                        sendToUser(client.userId, 'receive_message', messageData);

                        // Send to receiver (all their sockets)
                        sendToUser(receiverId, 'receive_message', messageData);

                        console.log(`Direct message from ${client.user.username} to ${receiverUser.username}`);
                        break;

                    case 'delete_message':
                        const { messageId } = payload || {};

                        if (!messageId) {
                            sendToClient(ws, 'error', { message: 'Message ID is required' });
                            return;
                        }

                        // Find the message
                        const messageToDelete = await Message.findById(messageId);

                        if (!messageToDelete) {
                            sendToClient(ws, 'error', { message: 'Message not found' });
                            return;
                        }

                        // Check if user is the sender or an admin
                        if (messageToDelete.sender.toString() !== client.userId && client.user.role !== 'admin') {
                            sendToClient(ws, 'error', { message: 'You are not authorized to delete this message' });
                            return;
                        }

                        // Soft delete (set deletedAt timestamp)
                        messageToDelete.deletedAt = new Date();
                        await messageToDelete.save();

                        // Notify both participants (sender and receiver)
                        const deletePayload = {
                            messageId: messageToDelete._id,
                            deletedBy: client.userId
                        };

                        sendToUser(messageToDelete.sender.toString(), 'message_deleted', deletePayload);
                        sendToUser(messageToDelete.receiver.toString(), 'message_deleted', deletePayload);

                        console.log(`Message ${messageId} deleted by ${client.user.username}`);
                        break;

                    case 'get_messages':
                        const { withUserId, limit = 50 } = payload || {};

                        if (!withUserId) {
                            sendToClient(ws, 'error', { message: 'withUserId is required to load conversation history' });
                            return;
                        }

                        const messages = await Message.find({
                            deletedAt: null,
                            $or: [
                                { sender: client.userId, receiver: withUserId },
                                { sender: withUserId, receiver: client.userId }
                            ]
                        })
                        .populate('sender', 'username email')
                        .populate('receiver', 'username email')
                        .sort({ createdAt: -1 })
                        .limit(parseInt(limit))
                        .lean();

                        // Reverse to show oldest first
                        messages.reverse();

                        sendToClient(ws, 'message_history', {
                            messages: messages
                        });
                        break;

                    default:
                        sendToClient(ws, 'error', { message: `Unknown message type: ${type}` });
                }
            } catch (error) {
                console.error('Error handling message:', error);
                sendToClient(ws, 'error', { 
                    message: 'Error processing message', 
                    error: error.message 
                });
            }
        });

        // Handle disconnection
        ws.on('close', () => {
            const client = clients.get(ws);
            if (client) {
                console.log(`User disconnected: ${client.user.username} (${client.userId})`);

                // Remove from userSockets map
                removeUserSocket(client.userId, ws);

                // Remove client
                clients.delete(ws);
            }
        });

        // Handle errors
        ws.on('error', (error) => {
            console.error('WebSocket error:', error);
            const client = clients.get(ws);
            if (client) {
                clients.delete(ws);
                removeUserSocket(client.userId, ws);
            }
        });
    });

    console.log('WebSocket server initialized');
};
