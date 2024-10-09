import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import passport from "passport";
import { OIDCStrategy } from "passport-azure-ad";
import session from "express-session";
import dotenv from "dotenv";
import path from "path";
import multer from "multer";
import fs from "fs";
import { fileURLToPath } from 'url';
import { dirname } from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure upload directories exist
const uploadDir = 'uploads/';
const fileUploadDir = 'uploads/files/';

if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}
if (!fs.existsSync(fileUploadDir)){
    fs.mkdirSync(fileUploadDir);
}

// Middleware
app.use(express.static("public"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static('uploads'));

// Setup session management
app.use(session({
    secret: process.env.CLIENT_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } // Set to true when using HTTPS
}));

app.use(passport.initialize());
app.use(passport.session());

// PostgreSQL Client
const db = new pg.Client({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT,
});

async function connectDb() {
    try {
        await db.connect();
        console.log('Connected to the database successfully');
    } catch (error) {
        console.error('Error connecting to the database:', error);
    }
}
connectDb();

// Set view engine to EJS
app.set('view engine', 'ejs');

// Define storage for profile pictures
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/'); // Ensure this directory exists
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname)); // Add timestamp to avoid name collisions
    }
});

const upload = multer({ 
    storage,
    fileFilter: (req, file, cb) => {
        const filetypes = /jpeg|jpg|png|gif|pdf|doc|docx|txt|ppt|pptx/; // Add more file types
        const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = filetypes.test(file.mimetype);

        if (extname && mimetype) {
            return cb(null, true);
        } else {
            cb('Error: File type not supported!');
        }
    }
});

// Function to find or create a user in the database
async function findOrCreateUser(email, microsoftId, name, surname) {
    try {
        if (!email.endsWith('@asoiu.edu.az')) {
            throw new Error('Invalid email domain');
        }

        let result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
        let user = result.rows[0];

        if (!user) {
            result = await db.query(
                `INSERT INTO users (email, microsoft_id, name, surname, created_at, bio) 
                 VALUES ($1, $2, $3, $4, NOW(), '') RETURNING *`,
                [email, microsoftId, name, surname]
            );
            user = result.rows[0];
            console.log('User created:', user);
        } else {
            console.log('User found:', user);
        }

        return user;
    } catch (error) {
        console.error('Error finding or creating user:', error);
        throw error;
    }
}

// Passport strategy
passport.use(new OIDCStrategy({
    identityMetadata: `https://login.microsoftonline.com/${process.env.TENANT_ID}/.well-known/openid-configuration`,
    clientID: process.env.CLIENT_ID,
    responseType: 'code id_token',
    responseMode: 'form_post',
    redirectUrl: process.env.REDIRECT_URI,
    allowHttpForRedirectUrl: true,
    clientSecret: process.env.CLIENT_SECRET,
    validateIssuer: true,
    passReqToCallback: false,
    scope: ['profile', 'email', 'openid', 'User.Read'],
}, 
async function(iss, sub, profile, accessToken, refreshToken, done) {
    const email = profile.upn || profile.unique_name;
    
    if (!email) {
        return done(new Error('No email or UPN found in the authentication response'));
    }

    if (!email.endsWith('@asoiu.edu.az') && !email.endsWith('@ufaz.edu.az')) {
        return done(new Error('Invalid email domain'));
    }

    const name = profile.name?.givenName || 'Unknown';
    const surname = profile.name?.familyName || 'Unknown';

    try {
        const user = await findOrCreateUser(email, sub, name, surname);
        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

// Serialize user to store in session
passport.serializeUser((user, done) => {
    done(null, user.id);
});

// Deserialize user from session
passport.deserializeUser(async (id, done) => {
    try {
        const result = await db.query("SELECT * FROM users WHERE id = $1", [id]);
        const user = result.rows[0];
        done(null, user);
    } catch (error) {
        done(error);
    }
});

// Main Routes
app.get('/', (req, res) => {
    res.render('home', { user: req.user });
});

app.get('/login', (req, res) => {
    res.render('login', { user: req.user });
});

app.get('/register', (req, res) => {
    res.render('register', { user: req.user });
});

app.get('/profile', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    res.render('profile', { user: req.user, currentUser: req.user });
});

app.get('/profile/edit', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    res.render('edit', { user: req.user });
});

// New Route: Search files
app.get('/search', async (req, res) => {
    const fullName = req.query.query.trim();  // Make sure to trim extra spaces
    const array = fullName.split(" ");
    const name = array[0] || ''; // Default to empty string if not provided
    const surname = array[1] || ''; // Default to empty string if not provided

    try {
        let userResult;
        let fileResult;
        
        // Search logic for users
        if (name && !surname) {
            userResult = await db.query(
                `SELECT * FROM users WHERE name ILIKE $1`, [`%${name}%`]
            );
        } else if (!name && surname) {
            userResult = await db.query(
                `SELECT * FROM users WHERE surname ILIKE $1`, [`%${surname}%`]
            );
        } else if (name && surname) {
            userResult = await db.query(
                `SELECT * FROM users WHERE name ILIKE $1 AND surname ILIKE $2`,
                [`%${name}%`, `%${surname}%`]
            );
        }

        // Search logic for files (assuming you search by filename or tags)
        fileResult = await db.query(
            `SELECT * FROM files WHERE file_name ILIKE $1 OR $2 = ANY(tags)`,
            [`%${fullName}%`, fullName]
        );
        

        const users = userResult ? userResult.rows : [];
        const files = fileResult ? fileResult.rows : [];

        if (users.length === 0 && files.length === 0) {
            return res.status(404).send('No users or files found');
        }

        // Render results with both users and files
        res.render('search-results', { users, files, user: req.user }); // Pass the user and files
    } catch (error) {
        console.error('Error searching for users or files:', error);
        res.status(500).send('Internal server error');
    }
});


// Profile picture upload route
app.post('/profile/edit/upload', upload.single('profilePicture'), async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const profilePicPath = req.file ? req.file.path : null; // Ensure the file is uploaded

    if (!profilePicPath) {
        console.error('No file uploaded');
        return res.redirect('/profile/edit');
    }

    try {
        // Update user's profile picture in the database
        await db.query(
            `UPDATE users SET profile_picture = $1 WHERE id = $2`,
            [profilePicPath, req.user.id]
        );

        console.log('Profile picture updated for user:', req.user.email);
        res.redirect('/profile');
    } catch (error) {
        console.error('Error updating profile picture:', error);
        res.redirect('/profile/edit');
    }
});

// Edit profile route
app.post('/profile/edit', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const { name, surname, bio } = req.body;

    try {
        // Update user's profile in the database
        await db.query(
            `UPDATE users SET name = $1, surname = $2, bio = $3 WHERE id = $4`,
            [name, surname, bio, req.user.id]
        );

        console.log('Profile updated for user:', req.user.email);
        res.redirect('/profile');
    } catch (error) {
        console.error('Error updating profile:', error);
        res.redirect('/profile');
    }
});

// New Route: Display file upload form
app.get('/files/upload', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    res.render('upload-file', { user: req.user }); // Ensure you create this 'upload.ejs' view
});

// New Route: List uploaded files
app.get('/files', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    try {
        const result = await db.query('SELECT * FROM files WHERE uploader_id = $1', [req.user.id]);
        res.render('files-list', { user: req.user, files: result.rows });
    } catch (error) {
        console.error('Error retrieving files:', error);
        res.redirect('/profile');
    }
});

// File upload route
app.post('/files/upload', upload.single('file'), async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const { file } = req;
    const { file_description, file_tags } = req.body;

    if (!file) {
        return res.status(400).send('No file uploaded.');
    }

    const { originalname, path } = file;

    try {
        // Split tags by commas and remove any extra whitespace
        const tagsArray = file_tags.split(',').map(tag => tag.trim());

        await db.query(
            `INSERT INTO files (file_name, file_path, uploader_id, description, tags, upload_date) 
             VALUES ($1, $2, $3, $4, $5, NOW()) RETURNING file_id`,
            [originalname, path, req.user.id, file_description, tagsArray]
        );

        res.redirect('/files');
    } catch (error) {
        console.error('Error uploading file:', error);
        res.redirect('/files/upload');
    }
});


// Delete file route
app.post('/files/delete/:fileId', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const { fileId } = req.params;

    try {
        // First, retrieve the file path from the database
        const result = await db.query('SELECT file_path FROM files WHERE file_id = $1 AND uploader_id = $2', [fileId, req.user.id]);
        const file = result.rows[0];

        if (!file) {
            return res.status(404).send('File not found.');
        }

        const filePath = path.join(__dirname, file.file_path);

        // Delete the file from the file system
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('Error deleting file from file system:', err);
                return res.status(500).send('Error deleting file.');
            }
        });

        // Delete the file entry from the database
        await db.query('DELETE FROM files WHERE file_id = $1 AND uploader_id = $2', [fileId, req.user.id]);

        console.log('File deleted:', fileId);
        res.redirect('/files'); // Redirect to the file list after deletion
    } catch (error) {
        console.error('Error deleting file:', error);
        res.status(500).send('Error deleting file.');
    }
});


// Download file route
app.get('/files/download/:fileId', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }

    const { fileId } = req.params;

    try {
        const result = await db.query('SELECT file_name, file_path FROM files WHERE file_id = $1', [fileId]);
        const file = result.rows[0];

        if (!file) {
            return res.status(404).send('File not found.');
        }

        const filePath = path.join(__dirname, file.file_path);
        res.download(filePath, file.file_name); // Set file download with original name
    } catch (error) {
        console.error('Error downloading file:', error);
        res.status(500).send('Error downloading file.');
    }
});

// Authentication Routes
app.get('/auth/azuread', passport.authenticate('azuread-openidconnect', {
    failureRedirect: '/login',
    scope: ['profile', 'email', 'openid', 'User.Read']
}));

app.post('/auth/azuread/callback', (req, res, next) => {
    passport.authenticate('azuread-openidconnect', (err, user, info) => {
        if (err) {
            console.error('Passport authentication error:', err);
            return res.redirect('/login');
        }
        if (!user) {
            console.warn('User not found or authentication failed. Info:', info);
            return res.redirect('/login');
        }
        req.logIn(user, (err) => {
            if (err) {
                console.error('Login error:', err);
                return res.redirect('/login');
            }
            res.redirect('/');
        });
    })(req, res, next);
});


// Logout route
app.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) {
            console.error('Logout error:', err);
        }
        res.redirect('/');
    });
});

// Start server
app.listen(port, () => {
    console.log(`Server is running on http://localhost:${port}`);
});
