const jwt = require('jsonwebtoken');
const url = require('url');
const User = require('../model/User');
const Message = require('../model/Message');

// Store active connections: Map<WebSocket, {userId, user, rooms: Set}>
const clients = new Map();

// Store rooms: Map<roomName, Set<WebSocket>>
const rooms = new Map();

module.exports = (wss) => {
    // Helper function to send message to a WebSocket
    function sendToClient(ws, type, data) {
        if (ws.readyState === 1) { // WebSocket.OPEN
            ws.send(JSON.stringify({ type, data }));
        }
    }

    // Helper function to broadcast to all clients in a room
    function broadcastToRoom(room, type, data, excludeWs = null) {
        const roomClients = rooms.get(room);
        if (roomClients) {
            roomClients.forEach(ws => {
                if (ws !== excludeWs && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type, data }));
                }
            });
        }
    }

    // Helper function to add client to room
    function joinRoom(ws, room) {
        if (!rooms.has(room)) {
            rooms.set(room, new Set());
        }
        rooms.get(room).add(ws);
        
        const client = clients.get(ws);
        if (client) {
            client.rooms.add(room);
        }
    }

    // Helper function to remove client from room
    function leaveRoom(ws, room) {
        const roomClients = rooms.get(room);
        if (roomClients) {
            roomClients.delete(ws);
            if (roomClients.size === 0) {
                rooms.delete(room);
            }
        }
        
        const client = clients.get(ws);
        if (client) {
            client.rooms.delete(room);
        }
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
                user: user,
                rooms: new Set()
            });

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

            // Auto-join default room
            joinRoom(ws, 'general');
            sendToClient(ws, 'room_joined', { room: 'general' });

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
                    case 'join_room':
                        const joinRoomName = payload?.room || 'general';
                        leaveRoom(ws, 'general'); // Leave default room if joining another
                        joinRoom(ws, joinRoomName);
                        console.log(`User ${client.user.username} joined room: ${joinRoomName}`);
                        sendToClient(ws, 'room_joined', { room: joinRoomName });
                        break;

                    case 'leave_room':
                        const leaveRoomName = payload?.room || 'general';
                        leaveRoom(ws, leaveRoomName);
                        console.log(`User ${client.user.username} left room: ${leaveRoomName}`);
                        sendToClient(ws, 'room_left', { room: leaveRoomName });
                        break;

                    case 'send_message':
                        const { content, room } = payload || {};

                        // Validate input
                        if (!content || content.trim().length === 0) {
                            sendToClient(ws, 'error', { message: 'Message content cannot be empty' });
                            return;
                        }

                        const messageRoom = room || 'general';

                        // Create message in database
                        const message = new Message({
                            sender: client.userId,
                            content: content.trim(),
                            room: messageRoom
                        });

                        await message.save();

                        // Populate sender information
                        await message.populate('sender', 'username email');

                        // Prepare message data
                        const messageData = {
                            _id: message._id,
                            sender: {
                                _id: message.sender._id,
                                username: message.sender.username,
                                email: message.sender.email
                            },
                            content: message.content,
                            room: message.room,
                            createdAt: message.createdAt
                        };

                        // Broadcast to all clients in the room
                        broadcastToRoom(messageRoom, 'receive_message', messageData);

                        console.log(`Message sent by ${client.user.username} in room ${messageRoom}`);
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

                        // Broadcast delete event to all clients in the room
                        broadcastToRoom(
                            messageToDelete.room || 'general',
                            'message_deleted',
                            {
                                messageId: messageToDelete._id,
                                room: messageToDelete.room || 'general',
                                deletedBy: client.userId
                            }
                        );

                        console.log(`Message ${messageId} deleted by ${client.user.username}`);
                        break;

                    case 'get_messages':
                        const { room: historyRoom, limit = 50 } = payload || {};
                        const roomName = historyRoom || 'general';

                        const messages = await Message.find({
                            room: roomName,
                            deletedAt: null
                        })
                        .populate('sender', 'username email')
                        .sort({ createdAt: -1 })
                        .limit(parseInt(limit))
                        .lean();

                        // Reverse to show oldest first
                        messages.reverse();

                        sendToClient(ws, 'message_history', {
                            room: roomName,
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
                
                // Remove from all rooms
                client.rooms.forEach(room => {
                    leaveRoom(ws, room);
                });
                
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
                client.rooms.forEach(room => {
                    leaveRoom(ws, room);
                });
            }
        });
    });

    console.log('WebSocket server initialized');
};
