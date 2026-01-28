const userModel = require('../model/User');


exports.register = async (req, res) => {
    try {
        const { username, email, password } = req.body;

        const existingUser = await userModel.findOne({ email });
        if (existingUser) {
            return res.status(409).json({
                status: "fail",
                message: "User already registered"
            });
        }

        const user = await userModel.create({ username, email, password });

        return res.status(201).json({
            status: "success",
            message: "User registered successfully",
            data: user,
            token: user.generateToken()
        });

    } catch (error) {
        return res.status(500).json({
            status: "fail",
            message: error.message
        });
    }
};

exports.login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await userModel.findOne({ email });
        if (!user) {
            return res.status(404).json({
                status: "fail",
                message: "User not found"
            });
        }

        const isPasswordCorrect = await user.comparePassword(password);
        if (!isPasswordCorrect) {
            return res.status(401).json({
                status: "fail",
                message: "Invalid password"
            });
        }

        return res.status(200).json({
            status: "success",
            message: "Login successful",
            data: user,
            token: user.generateToken()
        });

    } catch (error) {
        return res.status(500).json({
            status: "fail",
            message: error.message
        });
    }
};