const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/contact.controller");
const { validate } = require("../utils/validators");

/**
 * @swagger
 * /contact:
 *   post:
 *     tags:
 *       - Contact
 *     summary: Submit contact form
 *     description: Submit a contact form message (public endpoint)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *               - subject
 *               - message
 *             properties:
 *               name:
 *                 type: string
 *                 minLength: 2
 *                 example: "John Doe"
 *               email:
 *                 type: string
 *                 format: email
 *                 example: "john@example.com"
 *               phone:
 *                 type: string
 *                 example: "+1234567890"
 *               subject:
 *                 type: string
 *                 example: "General Inquiry"
 *               message:
 *                 type: string
 *                 minLength: 10
 *                 example: "I have a question about my shipment..."
 *     responses:
 *       200:
 *         description: Message sent successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Message sent. We will get back to you shortly."
 *       400:
 *         description: Validation failed
 *       429:
 *         description: Too many requests
 */
router.post("/contact", validate({
  name:    require("joi").string().min(2).required(),
  email:   require("joi").string().email().required(),
  phone:   require("joi").string().optional(),
  subject: require("joi").string().required(),
  message: require("joi").string().min(10).required(),
}), ctrl.submitContact);

module.exports = router;