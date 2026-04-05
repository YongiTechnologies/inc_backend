const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, index: true },
    phone: { type: String, trim: true },
    password: { type: String, select: false }, // Removed required: true
    role: {
      type: String,
      enum: ["customer", "employee", "admin"],
      default: "customer",
    },
    isVerified: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
    fcmToken: { type: String }, // Firebase push token
    googleId: { type: String, sparse: true, index: true },
    provider: { type: String, enum: ["local", "google"], default: "local" },
    avatar: { type: String }, // Google profile photo URL
    passwordResetToken: { type: String, select: false },
    passwordResetExpires: { type: Date },
  },
  { timestamps: true }
);

userSchema.pre("save", async function (next) {
  // Only hash password if it exists and is modified
  if (this.password && this.isModified("password")) {
    this.password = await bcrypt.hash(this.password, 12);
  }

  // Enforce password requirement for local users
  if (this.provider === "local" && !this.password) {
    return next(new Error("Password required for local authentication"));
  }

  next();
});

userSchema.methods.comparePassword = async function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

module.exports = mongoose.model("User", userSchema);
