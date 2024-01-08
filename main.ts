import dotenv from 'dotenv';

import spotifyApi from './auth';
import { artists, results, playlistIds, lastLikedTracks, lastPlaylistTracks } from './data'
import { waitForAccessToken, getLikedTracks, retryRequest, checkIfLikedTracksHaveChanged, getPlaylistTracks, getAllTracksByArtist, writeToDataFile } from './utils';
import type { FilteredTrack } from './utils';

dotenv.config();

async function addAllSongsToPlaylist() {
	const tokenFetched = await waitForAccessToken();
	if (!tokenFetched) {
		console.log('Failed to fetch access token. Trying again in 1 second...')
		await new Promise((resolve) => setTimeout(resolve, 1000));
		addAllSongsToPlaylist();
		return;
	}

	const fetchLikedTracks = await checkIfLikedTracksHaveChanged();
	try {
		// If we need to fetch liked tracks, do so and write the result to the file system, otherwise use the last liked tracks
		let likedTracks: FilteredTrack[] = []
		if (fetchLikedTracks) {
			console.log('Fetching liked tracks...')
			likedTracks = await getLikedTracks();
		}
		else {
			likedTracks = lastLikedTracks;
		}

		// Check if we need to fetch playlist tracks
		let playlistIdIndex = 0;

		let failCount = 0;
		for (let i = 0; i < artists.length; i++) {
			// If playlist is full, use the next playlist, or create a new one if there are no more
			if (lastPlaylistTracks[playlistIds[playlistIdIndex]].length >= 8000) {
				console.log('Reached the 8000 song limit for a playlist. Using next playlist...')
				playlistIdIndex++;

				// If we have reached the end of the playlistIds array, create a new playlist
				if (playlistIdIndex >= playlistIds.length) {
					console.log('Reached the end of the playlistIds array. Creating a new playlist...')

					let newPlaylist;
					try {
						newPlaylist = await spotifyApi.createPlaylist(`Discover House ${playlistIds.length + 1}`, { public: false });
					}
					catch (err) {
						await retryRequest(err, failCount);
						failCount++;
						i--;
						continue;
					}

					playlistIds.push(newPlaylist.body.id);
					playlistIdIndex = playlistIds.length - 1;
					lastPlaylistTracks[playlistIds[playlistIdIndex]] = [];
				}

				i--;
				continue;
			}

			// If we already added songs by this artist, skip them
			if (results[artists[i]]) {
				results[artists[i]].skipped = true;
				console.log('Skipping artist', artists[i], 'because we already added their songs.')
				continue;
			}

			console.log('Fetching playlist tracks...')
			let playlistTracksData = await getPlaylistTracks(true);

			let artist;
			try {
				artist = await spotifyApi.searchArtists(artists[i]);
			}
			catch (err) {
				await retryRequest(err, failCount);
				failCount++;
				i--;
				continue;
			}

			// If we found an artist, get all their albums and add all their songs to the playlist
			if (
				artist.body.artists &&
				artist.body.artists.items &&
				artist.body.artists.items.length > 0
			) {
				const artistId = artist.body.artists.items[0].id;
				const artistName = artist.body.artists.items[0].name;
				const { unlikedTracksInPlaylists: allTracksByArtist, resultsRecord } = await getAllTracksByArtist(artistId, artistName, likedTracks, i);
				const trackNames = allTracksByArtist.map((track) => track.name);
				const trackUris = allTracksByArtist.map((track) => track.uri);
				const trackArtists = allTracksByArtist.map((track) => track.artist);

				let failCount = 0;
				if (trackUris.length + lastPlaylistTracks[playlistIds[playlistIdIndex]].length > 8000) {
					console.log('Reached the 8000 song limit for a playlist. Using next playlist...')
					playlistIdIndex = playlistIds.length - 1;

					// If we have reached the end of the playlistIds array, create a new playlist
					if (trackUris.length + lastPlaylistTracks[playlistIds[playlistIdIndex]].length > 8000) {
						console.log('Reached the end of the playlistIds array. Creating a new playlist...')
						let newPlaylist;
						try {
							newPlaylist = await spotifyApi.createPlaylist(`Discover House ${playlistIds.length + 1}`, { public: false });
						}
						catch (err) {
							await retryRequest(err, failCount);
							failCount++;
							i--;
							continue;
						}

						playlistIds.push(newPlaylist.body.id);
						playlistIdIndex = playlistIds.length - 1;
						lastPlaylistTracks[playlistIds[playlistIdIndex]] = [];
					}
				}

				results[artists[i]] = resultsRecord;
				// Add all unique tracks by the artist that aren't already liked or already in the playlist to the playlist, 100 at a time
				for (let j = 0; j < trackUris.length; j += 100) {
					console.log('Adding track', j + 1, 'to', j + 101, 'of', trackUris.length, 'by', artistName)
					try {
						// Add up to 100 tracks at a time to playlist
						if (j + 100 < trackUris.length) {
							await spotifyApi.addTracksToPlaylist(playlistIds[playlistIdIndex], trackUris.slice(j, j + 100));
							results[artists[i]].addedSongs = results[artists[i]].addedSongs + 100;
						}
						else {
							await spotifyApi.addTracksToPlaylist(playlistIds[playlistIdIndex], trackUris.slice(j, trackUris.length));
							results[artists[i]].addedSongs = results[artists[i]].addedSongs + trackUris.length - j;
						}
						for (let k = j; k < j + 100 && k < trackUris.length; k++) {
							playlistTracksData[playlistIds[playlistIdIndex]].push({
								artist: trackArtists[k],
								uri: trackUris[k],
								name: trackNames[k]
							});
						}
					}
					catch (err) {
						await retryRequest(err, failCount);
						failCount++;
						j--;
						continue;
					}
				}

				console.log(`Successfully added all songs by ${artistName} to the playlist.`);

				console.log(`Added ${results[artists[i]].addedSongs} songs and skipped ${results[artists[i]].skippedSongs} songs.`)
			} else {
				console.log(`No artist found with the name ${artists[i]}.`);
			}

			console.log('Writing results to the file system...')
			// Write result to the file system
			writeToDataFile(Date.now(), likedTracks, playlistIds, playlistTracksData, artists, results);
		}
	} catch (error) {
		console.error('Error adding songs to playlist:', error);
	}
	console.log('Finished!');
}

addAllSongsToPlaylist();
