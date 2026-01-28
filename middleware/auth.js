const jwt = require('jsonwebtoken');
const userModel = require('../model/User');

exports.authenticate = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            return res.status(401).json({
                status: "fail",
                message: "Authorization token missing"
            });
        }

        const token = authHeader.split(' ')[1];
        if (!token) {
            return res.status(401).json({
                status: "fail",
                message: "Token not provided"
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        const user = await userModel.findById(decoded.id);
        if (!user) {
            return res.status(404).json({
                status: "fail",
                message: "User not found"
            });
        }

        req.user = user;
        next();

    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({
                status: "fail",
                message: "Token expired"
            });
        }

        if (error.name === 'JsonWebTokenError') {
            return res.status(401).json({
                status: "fail",
                message: "Invalid token"
            });
        }

        return res.status(500).json({
            status: "fail",
            message: error.message
        });
    }
};

exports.roleGuard = (...roles) => {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.role)) {
            return res.status(403).json({
                status: "fail",
                message: "You are not allowed to access this resource"
            });
        }
        next();
    };
};

exports.adminGuard = (req, res, next) => {
    return exports.roleGuard('admin')(req, res, next);
};

exports.userGuard = (req, res, next) => {
    return exports.roleGuard('user')(req, res, next);
};
