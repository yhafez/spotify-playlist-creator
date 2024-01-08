import express from 'express';
import SpotifyWebApi from 'spotify-web-api-node';
import dotenv from 'dotenv';
import { exec } from 'child_process';
import crypto from 'crypto';

dotenv.config();

const clientId = process.env.SPOTIFY_CLIENT_ID as string;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET as string;
const redirectUri = process.env.SPOTIFY_REDIRECT_URI as string;

const scopes = ['playlist-modify-private', 'playlist-modify-public', 'user-library-read', 'user-library-modify'];
const spotifyApi = new SpotifyWebApi({
	clientId: clientId,
	clientSecret: clientSecret,
	redirectUri: redirectUri,
});

const app = express();

app.get('/login', (req, res) => {
	const state = crypto.randomBytes(16).toString('hex');
	res.redirect(spotifyApi.createAuthorizeURL(scopes, state));
});

app.get('/callback', async (req, res) => {
	const { code } = req.query;

	try {
		const data = await spotifyApi.authorizationCodeGrant(code as string);
		const { access_token, refresh_token } = data.body;

		spotifyApi.setAccessToken(access_token);
		spotifyApi.setRefreshToken(refresh_token);

		console.log('Access token:', access_token);
		console.log('Refresh token:', refresh_token);

		res.send('Success! You can now close the window.');
	} catch (error) {
		console.error('Error getting tokens:', error);
		res.send('Error getting tokens. Check the console for more information.');
	}
});

app.get('/success', (req, res) => {
	res.send('You can now close this window and run the main application.');
});

app.listen(8888, () => {
	console.log('Server started on port 8888.');
	exec('open http://localhost:8888/login');
});

export default spotifyApi;
